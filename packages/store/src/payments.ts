import { randomUUID } from "node:crypto";
import {
  AccountId,
  PaymentId,
  LedgerTransactionId,
  isCurrencyCode,
  recordScope,
  transitionPayment,
  type Actor,
  type Money,
  type PaymentState,
  type ProviderPayment,
  type SystemPrincipal,
  type SandboxMode,
} from "@relay/domain";
import { currentActor } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import { idempotent } from "./idempotency.ts";
import { AccessError } from "./errors.ts";
import { InvariantError } from "./lead-row.ts";
import { scopeWhere } from "./scope.ts";
import type { Payment, Prisma } from "./generated/client.ts";
import { transact, type Db, type Tx } from "./tx.ts";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new InvariantError("Invalid payment record");
  return value;
}
function money(amount: bigint, currency: string): Money {
  if (!isCurrencyCode(currency)) throw new InvariantError("Invalid payment currency");
  return { minor: amount, currency };
}
function stateOf(row: Payment): PaymentState {
  switch (row.status) {
    case "checkoutCreated":
      return { status: row.status };
    case "completed": {
      if (row.completedBy !== "providerWebhook" && row.completedBy !== "reconciler")
        throw new InvariantError("Invalid settlement caller");
      return { status: row.status, by: row.completedBy, at: required(row.decidedAt) };
    }
    case "needsReview":
      return {
        status: row.status,
        reported: money(required(row.reportedAmount), required(row.reportedCurrency)),
        at: required(row.decidedAt),
      };
    case "failed":
      return { status: row.status, reason: required(row.reason), at: required(row.decidedAt) };
    case "expired":
      return { status: row.status, at: required(row.decidedAt) };
    default:
      throw new InvariantError("Invalid payment state");
  }
}
function columns(state: PaymentState) {
  return {
    status: state.status,
    decidedAt: "at" in state ? state.at : null,
    completedBy: state.status === "completed" ? state.by : null,
    reportedAmount: state.status === "needsReview" ? state.reported.minor : null,
    reportedCurrency: state.status === "needsReview" ? state.reported.currency : null,
    reason: state.status === "failed" ? state.reason : null,
  };
}
function snapshot(row: Payment) {
  return {
    status: row.status,
    amount: row.amount.toString(),
    currency: row.currency,
    reportedAmount: row.reportedAmount?.toString() ?? null,
    reportedCurrency: row.reportedCurrency,
    reason: row.reason,
  };
}
function payment(row: Payment) {
  if (row.kind !== "first" && row.kind !== "repeat")
    throw new InvariantError("Invalid payment kind");
  return {
    id: required(PaymentId.parse(row.id)),
    accountId: required(AccountId.parse(row.accountId)),
    method: "card" as const,
    kind: row.kind,
    money: money(row.amount, row.currency),
    state: stateOf(row),
    recordedById: row.recordedById,
    soldById: row.soldById,
    createdAt: row.createdAt,
    nextCheckAt: row.nextCheckAt,
  };
}
export interface CreatePayment {
  readonly key: string;
  readonly accountId: AccountId;
  readonly money: Money;
  readonly kind: "first" | "repeat";
  readonly mode: SandboxMode;
}
function receipt(value: unknown): { id: PaymentId } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  )
    throw new InvariantError("Invalid checkout receipt");
  return { id: required(PaymentId.parse(value.id)) };
}
export async function createPayment(
  db: Db,
  actor: Actor,
  input: CreatePayment,
  firstCheckMs: number,
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    return idempotent(
      tx,
      current,
      {
        key: input.key,
        operation: "createCheckout",
        request: {
          accountId: input.accountId,
          amount: input.money.minor.toString(),
          currency: input.money.currency,
          kind: input.kind,
          mode: input.mode,
        },
      },
      receipt,
      async (requestId) => {
        const account = await tx.account.findFirst({
          where: { id: input.accountId, ...scopeWhere(recordScope(current, "payment", "edit")) },
        });
        if (!account) throw new AccessError("accessDenied");
        const at = new Date();
        const row = await tx.payment.create({
          data: {
            accountId: account.id,
            amount: input.money.minor,
            currency: input.money.currency,
            kind: input.kind,
            recordedById: current.userId,
            soldById: account.ownerId,
            createdAt: at,
            nextCheckAt: new Date(at.getTime() + firstCheckMs),
            sandboxMode: input.mode,
          },
        });
        await tx.paymentEvent.create({
          data: {
            paymentId: row.id,
            kind: "checkoutCreated",
            at,
            detail: {
              recordedById: current.userId,
              amount: row.amount.toString(),
              currency: row.currency,
            },
          },
        });
        await writeAudit(tx, current, {
          action: "checkoutCreated",
          subject: { type: "payment", id: required(PaymentId.parse(row.id)) },
          before: {},
          after: snapshot(row),
          cause: { kind: "idempotency", id: requestId },
          at,
        });
        return { id: row.id };
      },
    );
  });
}
export async function checkoutTerms(db: Db, actor: Actor, id: PaymentId) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = required(await tx.payment.findUnique({ where: { id } }));
    // A replay may finish provider creation after account ownership changed, but only for its recorder.
    if (row.recordedById !== current.userId) throw new AccessError("accessDenied");
    const mode = row.sandboxMode;
    if (
      mode !== "normal" &&
      mode !== "drop" &&
      mode !== "twice" &&
      mode !== "late" &&
      mode !== "differentAmount"
    )
      throw new InvariantError("Invalid sandbox mode");
    return { paymentId: row.id, money: money(row.amount, row.currency), mode } as const;
  });
}

export interface SettlementResult {
  readonly status: PaymentState["status"];
  readonly changed: boolean;
}
async function settlePayment(
  tx: Tx,
  principal: SystemPrincipal,
  paymentId: string,
  observed: ProviderPayment,
  requestId: string,
  at: Date,
): Promise<SettlementResult> {
  if (recordScope(principal, "payment", "settle").kind !== "all")
    throw new AccessError("accessDenied");
  const by = principal.name;
  if (by !== "providerWebhook" && by !== "reconciler") throw new AccessError("accessDenied");
  const row = required(await tx.payment.findUnique({ where: { id: paymentId } }));
  const before = stateOf(row);
  const next = transitionPayment(
    before,
    { type: "provider", result: observed, by },
    money(row.amount, row.currency),
    at,
  );
  if (next === before) return { status: before.status, changed: false };
  const updated = await tx.payment.update({ where: { id: row.id }, data: columns(next) });
  const cause = { kind: "request", id: requestId } as const;
  await writeAudit(tx, principal, {
    action: "paymentStateChanged",
    subject: { type: "payment", id: required(PaymentId.parse(row.id)) },
    before: snapshot(row),
    after: snapshot(updated),
    cause,
    at,
  });
  if (next.status === "completed") {
    let customer = await tx.ledgerAccount.findUnique({
      where: { accountId_currency: { accountId: row.accountId, currency: row.currency } },
    });
    customer ??= await tx.ledgerAccount.create({
      data: { accountId: row.accountId, currency: row.currency, kind: "customer" },
    });
    let provider = await tx.ledgerAccount.findFirst({
      where: { kind: "cardProviderSandbox", currency: row.currency },
    });
    provider ??= await tx.ledgerAccount.create({
      data: { currency: row.currency, kind: "cardProviderSandbox" },
    });
    const posting = await tx.ledgerTransaction.create({ data: { paymentId: row.id, at } });
    await tx.ledgerLine.createMany({
      data: [
        { transactionId: posting.id, ledgerAccountId: customer.id, amount: row.amount },
        { transactionId: posting.id, ledgerAccountId: provider.id, amount: -row.amount },
      ],
    });
    await writeAudit(tx, principal, {
      action: "ledgerPosted",
      subject: { type: "ledger", id: required(LedgerTransactionId.parse(posting.id)) },
      before: {},
      after: { paymentId: row.id, amount: row.amount.toString(), currency: row.currency, by },
      cause,
      at,
    });
    await tx.outbox.create({
      data: {
        paymentId: row.id,
        topic: "paymentCompleted",
        payload: {
          paymentId: row.id,
          accountId: row.accountId,
          amount: row.amount.toString(),
          currency: row.currency,
        },
        createdAt: at,
        nextAttemptAt: at,
      },
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: row.id,
        kind: "settlement",
        at,
        detail: {
          by,
          transactionId: posting.id,
          amount: row.amount.toString(),
          currency: row.currency,
        },
      },
    });
  }
  return { status: next.status, changed: true };
}
function observationDetail(
  observed: ProviderPayment,
  outcome: SettlementResult,
): Prisma.InputJsonObject {
  return {
    providerStatus: observed.status,
    reportedAmount: observed.money.minor.toString(),
    reportedCurrency: observed.money.currency,
    ...outcome,
  };
}
export interface ProviderEvent {
  readonly eventId: string;
  readonly paymentId: PaymentId;
  readonly payloadHash: string;
  readonly observed: ProviderPayment;
}
export async function receivePaymentWebhook(db: Db, event: ProviderEvent) {
  return transact(db, async (tx) => {
    const at = new Date();
    const prior = await tx.webhookInbox.findUnique({ where: { eventId: event.eventId } });
    if (prior && (prior.paymentId !== event.paymentId || prior.payloadHash !== event.payloadHash))
      throw new AccessError("conflict");
    const row = required(await tx.payment.findUnique({ where: { id: event.paymentId } }));
    const late = row.status !== "checkoutCreated";
    const outcome = prior
      ? { status: stateOf(row).status, changed: false }
      : await settlePayment(
          tx,
          { kind: "system", name: "providerWebhook" },
          row.id,
          event.observed,
          randomUUID(),
          at,
        );
    if (!prior)
      await tx.webhookInbox.create({
        data: {
          eventId: event.eventId,
          paymentId: row.id,
          payloadHash: event.payloadHash,
          receivedAt: at,
        },
      });
    await tx.paymentEvent.create({
      data: {
        paymentId: row.id,
        kind: "webhookDelivery",
        at,
        detail: {
          ...observationDetail(event.observed, outcome),
          eventId: event.eventId,
          duplicate: prior !== null,
          late,
        },
      },
    });
    return { ...outcome, duplicate: prior !== null };
  });
}

const RECONCILER = { kind: "system", name: "reconciler" } as const;
export async function duePayments(db: Db, at: Date, limit: number) {
  if (recordScope(RECONCILER, "payment", "reconcile").kind !== "all")
    throw new AccessError("accessDenied");
  return db.payment.findMany({
    where: { status: "checkoutCreated", nextCheckAt: { lte: at } },
    orderBy: [{ nextCheckAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
}
export async function claimPaymentCheck(db: Db, id: string, at: Date, intervalMs: number) {
  const token = randomUUID();
  return transact(db, async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id, status: "checkoutCreated", nextCheckAt: { lte: at } },
      data: { checkToken: token, nextCheckAt: new Date(at.getTime() + intervalMs) },
    });
    return claimed.count === 1 ? token : null;
  });
}
export async function finishPaymentCheck(
  db: Db,
  id: string,
  token: string,
  observed: ProviderPayment | null,
) {
  return transact(db, async (tx) => {
    const row = required(await tx.payment.findUnique({ where: { id } }));
    if (row.checkToken !== token) return { status: stateOf(row).status, changed: false };
    const at = new Date();
    const outcome =
      observed === null
        ? { status: stateOf(row).status, changed: false }
        : await settlePayment(tx, RECONCILER, row.id, observed, token, at);
    await tx.paymentEvent.create({
      data: {
        paymentId: id,
        kind: "reconcilerCheck",
        at,
        detail:
          observed === null
            ? { ...outcome, error: "Provider status unavailable", checkId: token }
            : { ...observationDetail(observed, outcome), checkId: token },
      },
    });
    return outcome;
  });
}

async function scopedPayment(tx: Tx, actor: Actor, id: PaymentId) {
  const row = await tx.payment.findUnique({ where: { id } });
  if (!row) throw new AccessError("accessDenied");
  const account = await tx.account.findFirst({
    where: { id: row.accountId, ...scopeWhere(recordScope(actor, "payment", "read")) },
  });
  if (!account) throw new AccessError("accessDenied");
  return row;
}
export async function closePaymentReview(db: Db, actor: Actor, id: PaymentId, reason: string) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    if (recordScope(current, "payment", "closeReview").kind !== "all")
      throw new AccessError("accessDenied");
    const row = await scopedPayment(tx, current, id);
    const before = stateOf(row);
    const at = new Date();
    const next = transitionPayment(
      before,
      { type: "closeReview", reason },
      money(row.amount, row.currency),
      at,
    );
    if (next === before) throw new AccessError("conflict");
    const updated = await tx.payment.update({ where: { id }, data: columns(next) });
    await writeAudit(tx, current, {
      action: "paymentReviewClosed",
      subject: { type: "payment", id },
      before: snapshot(row),
      after: snapshot(updated),
      cause: { kind: "request", id: randomUUID() },
      at,
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: id,
        kind: "reviewClosed",
        at,
        detail: {
          reason: reason.trim(),
          actorId: current.userId,
          reportedAmount: row.reportedAmount?.toString(),
          reportedCurrency: row.reportedCurrency,
        },
      },
    });
    return payment(updated);
  });
}
async function posting(tx: Tx, id: string) {
  const transaction = await tx.ledgerTransaction.findUnique({ where: { paymentId: id } });
  if (!transaction) return null;
  const lines = await tx.ledgerLine.findMany({
    where: { transactionId: transaction.id },
    orderBy: { amount: "desc" },
  });
  const accounts = await tx.ledgerAccount.findMany({
    where: { id: { in: lines.map((l) => l.ledgerAccountId) } },
  });
  const customers = await tx.account.findMany({
    where: { id: { in: accounts.flatMap((a) => (a.accountId ? [a.accountId] : [])) } },
    include: { lead: { select: { name: true, email: true } } },
  });
  return {
    ...transaction,
    lines: lines.map((line) => {
      const account = required(accounts.find((a) => a.id === line.ledgerAccountId));
      const customer = customers.find((c) => c.id === account.accountId);
      return {
        ...line,
        account: {
          ...account,
          name:
            account.kind === "cardProviderSandbox"
              ? "Card provider, sandbox"
              : (customer?.lead?.name ?? customer?.lead?.email ?? account.accountId),
        },
      };
    }),
  };
}
export async function getPayment(db: Db, actor: Actor, id: PaymentId) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = await scopedPayment(tx, current, id);
    const events = await tx.paymentEvent.findMany({
      where: { paymentId: id },
      orderBy: { sequence: "asc" },
    });
    return {
      ...payment(row),
      events,
      posting: recordScope(current, "ledger", "read").kind === "all" ? await posting(tx, id) : null,
    };
  });
}
export async function listPayments(db: Db, actor: Actor, limit: number) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const accounts = await tx.account.findMany({
      where: scopeWhere(recordScope(current, "payment", "read")),
      include: { lead: { select: { name: true, email: true } } },
    });
    const accountId = { in: accounts.map((a) => a.id) };
    const week = new Date();
    week.setUTCHours(0, 0, 0, 0);
    week.setUTCDate(week.getUTCDate() - ((week.getUTCDay() + 6) % 7));
    const rows: Payment[] = [];
    for (const filter of [
      { status: "checkoutCreated" },
      { status: "needsReview" },
      { status: { in: ["completed", "failed", "expired"] }, decidedAt: { gte: week } },
    ]) {
      rows.push(
        ...(await tx.payment.findMany({
          where: { accountId, ...filter },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
        })),
      );
    }
    const users = await tx.user.findMany({
      where: {
        id: {
          in: rows.flatMap((r) => (r.soldById ? [r.recordedById, r.soldById] : [r.recordedById])),
        },
      },
      select: { id: true, name: true },
    });
    const items = rows.map((row) => ({
      ...payment(row),
      account: accounts.find((a) => a.id === row.accountId)?.lead ?? null,
      recordedBy: users.find((u) => u.id === row.recordedById) ?? null,
      soldBy: users.find((u) => u.id === row.soldById) ?? null,
    }));
    return {
      waitingForProvider: items.filter((p) => p.state.status === "checkoutCreated").slice(0, limit),
      needsReview: items.filter((p) => p.state.status === "needsReview").slice(0, limit),
      decidedThisWeek: items
        .filter((p) => "at" in p.state && p.state.status !== "needsReview" && p.state.at >= week)
        .slice(0, limit),
    };
  });
}
export async function accountLedger(db: Db, actor: Actor, accountId: AccountId) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    if (recordScope(current, "ledger", "read").kind !== "all")
      throw new AccessError("accessDenied");
    const account = await tx.account.findFirst({
      where: { id: accountId, ...scopeWhere(recordScope(current, "account", "read")) },
    });
    if (!account) {
      throw new AccessError("accessDenied");
    }
    const ledgerAccounts = await tx.ledgerAccount.findMany({
      where: { accountId },
      orderBy: { currency: "asc" },
    });
    const balances = [];
    for (const ledgerAccount of ledgerAccounts) {
      const lines = await tx.ledgerLine.findMany({ where: { ledgerAccountId: ledgerAccount.id } });
      const transactions = await tx.ledgerTransaction.findMany({
        where: { id: { in: lines.map((l) => l.transactionId) } },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      });
      let balance = 0n;
      const entries = [];
      for (const transaction of transactions) {
        const line = required(lines.find((l) => l.transactionId === transaction.id));
        balance += line.amount;
        entries.push({
          paymentId: transaction.paymentId,
          at: transaction.at,
          amount: line.amount,
          balance,
          posting: await posting(tx, transaction.paymentId),
        });
      }
      balances.push({ currency: ledgerAccount.currency, balance, entries });
    }
    return { accountId, balances };
  });
}
