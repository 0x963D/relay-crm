import { receiptDetail } from "./outbox.ts";
import { randomUUID } from "node:crypto";
import {
  AccountId,
  UserId,
  PaymentId,
  LedgerTransactionId,
  isCurrencyCode,
  recordScope,
  transitionPayment,
  type Actor,
  type PaymentEvent,
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
    case "pendingApproval":
    case "checkoutCreated":
      return { status: row.status };
    case "completed": {
      if (
        row.completedBy !== "providerWebhook" &&
        row.completedBy !== "reconciler" &&
        row.completedBy !== "manualApproval"
      )
        throw new InvariantError("Invalid settlement caller");
      return { status: row.status, by: row.completedBy, at: required(row.decidedAt) };
    }
    case "needsReview":
      if (
        row.reason !== "amount mismatch" &&
        row.reason !== "currency mismatch" &&
        row.reason !== "paid after close"
      )
        throw new InvariantError("Invalid review reason");
      return {
        reason: row.reason,
        status: row.status,
        reported: money(required(row.reportedAmount), required(row.reportedCurrency)),
        at: required(row.decidedAt),
      };
    case "rejected":
    case "cancelled":
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
    reason: "reason" in state ? state.reason : null,
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
    method: row.method,
    version: row.version,
    receiptHash: row.receiptHash,
    reference: row.reference,
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
  requestId: string,
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
      async (idempotencyId) => {
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
              requestId,
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
          cause: { kind: "idempotency", id: idempotencyId, requestId },
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
export async function settlePayment(
  tx: Tx,
  principal: SystemPrincipal | Actor,
  paymentId: string,
  event: PaymentEvent,
  requestId: string,
  at: Date,
  recordObservation?: (outcome: SettlementResult) => Promise<void>,
): Promise<SettlementResult> {
  const by =
    event.type === "approve" ? "manualApproval" : event.type === "provider" ? event.by : null;
  if (
    !by ||
    recordScope(principal, "payment", by === "manualApproval" ? "approve" : "settle").kind !== "all"
  )
    throw new AccessError("accessDenied");
  const row = required(await tx.payment.findUnique({ where: { id: paymentId } }));
  if ((row.method === "manual") !== (by === "manualApproval"))
    throw new AccessError("accessDenied");
  const before = stateOf(row);
  const next = transitionPayment(before, event, money(row.amount, row.currency), at);
  const outcome = { status: next.status, changed: next !== before };
  await recordObservation?.(outcome);
  if (next === before) return outcome;
  const posting =
    next.status === "completed"
      ? await tx.ledgerTransaction.create({ data: { paymentId: row.id, at } })
      : null;
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
  if (posting) {
    let customer = await tx.ledgerAccount.findUnique({
      where: { accountId_currency: { accountId: row.accountId, currency: row.currency } },
    });
    customer ??= await tx.ledgerAccount.create({
      data: { accountId: row.accountId, currency: row.currency, kind: "customer" },
    });
    const debitKind = row.method === "manual" ? "bankTransfersCash" : "cardProviderSandbox";
    let provider = await tx.ledgerAccount.findFirst({
      where: { kind: debitKind, currency: row.currency },
    });
    provider ??= await tx.ledgerAccount.create({
      data: { currency: row.currency, kind: debitKind },
    });
    await tx.ledgerLine.createMany({
      data: [
        {
          transactionId: posting.id,
          ledgerAccountId: customer.id,
          side: "credit",
          amount: row.amount,
        },
        {
          transactionId: posting.id,
          ledgerAccountId: provider.id,
          side: "debit",
          amount: row.amount,
        },
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
    const account = required(
      await tx.account.findUnique({
        where: { id: row.accountId },
        include: { lead: { select: { email: true } } },
      }),
    );
    await tx.outbox.create({
      data: {
        paymentId: row.id,
        topic: "paymentCompleted",
        recipient: account.lead?.email ?? null,
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
          requestId,
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
    ...(observed.status === "missing"
      ? {}
      : {
          reportedAmount: observed.money.minor.toString(),
          reportedCurrency: observed.money.currency,
        }),
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
    const recordDelivery = async (outcome: SettlementResult) => {
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
    };
    if (!prior)
      await tx.webhookInbox.create({
        data: {
          eventId: event.eventId,
          paymentId: row.id,
          payloadHash: event.payloadHash,
          receivedAt: at,
        },
      });
    const outcome = prior
      ? { status: stateOf(row).status, changed: false }
      : await settlePayment(
          tx,
          { kind: "system", name: "providerWebhook" },
          row.id,
          { type: "provider", result: event.observed, by: "providerWebhook" },
          randomUUID(),
          at,
          recordDelivery,
        );
    if (prior) await recordDelivery(outcome);
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
    const superseded = row.checkToken !== token;
    const at = new Date();
    const recordCheck = async (outcome: SettlementResult) => {
      await tx.paymentEvent.create({
        data: {
          paymentId: id,
          kind: "reconcilerCheck",
          at,
          detail:
            observed === null
              ? { ...outcome, error: "Provider status unavailable", checkId: token, superseded }
              : { ...observationDetail(observed, outcome), checkId: token, superseded },
        },
      });
    };
    const outcome =
      observed === null || superseded
        ? { status: stateOf(row).status, changed: false }
        : await settlePayment(
            tx,
            RECONCILER,
            row.id,
            { type: "provider", result: observed, by: "reconciler" },
            token,
            at,
            recordCheck,
          );
    if (observed === null || superseded) await recordCheck(outcome);
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
export async function closePayment(
  db: Db,
  actor: Actor,
  id: PaymentId,
  reason: string,
  requestId: string,
  type: "closeReview" | "closeCheckout",
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    if (type === "closeReview" && recordScope(current, "payment", "closeReview").kind !== "all")
      throw new AccessError("accessDenied");
    const row = await scopedPayment(tx, current, id);
    if (
      type === "closeCheckout" &&
      !(await tx.account.findFirst({
        where: { id: row.accountId, ...scopeWhere(recordScope(current, "account", "edit")) },
      }))
    )
      throw new AccessError("accessDenied");
    const before = stateOf(row);
    const at = new Date();
    const next = transitionPayment(before, { type, reason }, money(row.amount, row.currency), at);
    if (next === before) throw new AccessError("conflict");
    const updated = await tx.payment.update({ where: { id }, data: columns(next) });
    await writeAudit(tx, current, {
      action: type === "closeReview" ? "paymentReviewClosed" : "paymentStateChanged",
      subject: { type: "payment", id },
      before: snapshot(row),
      after: snapshot(updated),
      cause: { kind: "request", id: requestId },
      at,
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: id,
        kind: type === "closeReview" ? "reviewClosed" : "checkoutClosed",
        at,
        detail: {
          reason: reason.trim(),
          requestId,
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
    orderBy: { side: "asc" },
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
              : account.kind === "bankTransfersCash"
                ? "Bank transfers and cash"
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
      ...(await approvalDetail(tx, current, row)),
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
      { status: "pendingApproval" },
      { status: "checkoutCreated" },
      { status: "needsReview" },
      {
        status: { in: ["completed", "failed", "expired", "rejected", "cancelled"] },
        decidedAt: { gte: week },
      },
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
    const items = await Promise.all(
      rows.map(async (row) => ({
        ...payment(row),
        ...(await approvalDetail(tx, current, row)),
        account: accounts.find((a) => a.id === row.accountId)?.lead ?? null,
        recordedBy: users.find((u) => u.id === row.recordedById) ?? null,
        soldBy: users.find((u) => u.id === row.soldById) ?? null,
      })),
    );
    return {
      waitingForApproval: items.filter((p) => p.state.status === "pendingApproval").slice(0, limit),
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
        balance += line.side === "credit" ? line.amount : -line.amount;
        entries.push({
          paymentId: transaction.paymentId,
          at: transaction.at,
          amount: line.amount,
          side: line.side,
          balance,
          posting: await posting(tx, transaction.paymentId),
        });
      }
      balances.push({ currency: ledgerAccount.currency, balance, entries });
    }
    return { accountId, balances };
  });
}

export interface ManualTerms {
  readonly money: Money;
  readonly receiptHash: string;
  readonly reference: string | null;
}
export interface RecordManualPayment extends ManualTerms {
  readonly accountId: AccountId;
  readonly key: string;
  readonly kind: "first" | "repeat";
}
export interface ManualDecision {
  readonly id: PaymentId;
  readonly version: number;
}
async function availableManualTerms(tx: Tx, accountId: string, hash: string, except?: string) {
  if (
    await tx.payment.findFirst({
      where: { accountId, status: "pendingApproval", ...(except ? { id: { not: except } } : {}) },
    })
  )
    throw new AccessError("pendingPayment");
  if (
    await tx.payment.findFirst({
      where: {
        receiptHash: hash,
        status: { notIn: ["rejected", "cancelled"] },
        ...(except ? { id: { not: except } } : {}),
      },
    })
  )
    throw new AccessError("receiptUsed");
}
export async function recordManualPayment(
  db: Db,
  actor: Actor,
  input: RecordManualPayment,
  requestId: string,
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    return idempotent(
      tx,
      current,
      {
        key: input.key,
        operation: "recordManualPayment",
        request: {
          accountId: input.accountId,
          amount: input.money.minor.toString(),
          currency: input.money.currency,
          receiptHash: input.receiptHash,
          reference: input.reference,
          kind: input.kind,
        },
      },
      receipt,
      async (idempotencyId) => {
        const account = await tx.account.findFirst({
          where: { id: input.accountId, ...scopeWhere(recordScope(current, "payment", "edit")) },
        });
        if (!account) throw new AccessError("accessDenied");
        await availableManualTerms(tx, account.id, input.receiptHash);
        const at = new Date();
        const row = await tx.payment.create({
          data: {
            accountId: account.id,
            method: "manual",
            status: "pendingApproval",
            amount: input.money.minor,
            currency: input.money.currency,
            kind: input.kind,
            recordedById: current.userId,
            soldById: account.ownerId,
            receiptHash: input.receiptHash,
            reference: input.reference,
            createdAt: at,
          },
        });
        await writeAudit(tx, current, {
          action: "manualPaymentRecorded",
          subject: { type: "payment", id: required(PaymentId.parse(row.id)) },
          before: {},
          after: { ...snapshot(row), receiptHash: row.receiptHash, reference: row.reference },
          cause: { kind: "idempotency", id: idempotencyId, requestId },
          at,
        });
        await tx.paymentEvent.create({
          data: {
            paymentId: row.id,
            kind: "manualRecorded",
            at,
            detail: { actorId: current.userId, requestId },
          },
        });
        return { id: row.id };
      },
    );
  });
}
async function waitingPayment(tx: Tx, actor: Actor, input: ManualDecision) {
  const row = await scopedPayment(tx, actor, input.id);
  if (row.status !== "pendingApproval" || row.version !== input.version)
    throw new AccessError("refreshConflict");
  // This write serializes approval, edits and final decisions on the same payment.
  await tx.payment.update({ where: { id: row.id }, data: { version: row.version } });
  return row;
}
export async function approveManualPayment(
  db: Db,
  actor: Actor,
  input: ManualDecision & { readonly roleVersion: number },
  requestId: string,
) {
  return transact(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.userId}::uuid FOR UPDATE`;
    const current = await currentActor(tx, actor);
    const user = required(await tx.user.findUnique({ where: { id: current.userId } }));
    if (user.roleVersion !== input.roleVersion) throw new AccessError("roleChanged");
    if (recordScope(current, "payment", "approve").kind !== "all")
      throw new AccessError("accessDenied");
    const visible = await scopedPayment(tx, current, input.id);
    if (visible.recordedById === current.userId) throw new AccessError("paymentRecorder");
    if (
      await tx.paymentApproval.findFirst({
        where: { paymentId: input.id, approverId: current.userId, voidedAt: null },
      })
    )
      throw new AccessError("alreadyApproved");
    const row = await waitingPayment(tx, current, input);
    const at = new Date();
    await tx.paymentApproval.create({
      data: {
        paymentId: row.id,
        approverId: current.userId,
        roleVersion: user.roleVersion,
        at,
        requestId,
      },
    });
    const approvals = await tx.paymentApproval.findMany({
      where: { paymentId: row.id, voidedAt: null },
    });
    for (const approval of approvals) {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${approval.approverId}::uuid FOR SHARE`;
      const approver = required(await tx.user.findUnique({ where: { id: approval.approverId } }));
      if (
        approver.roleVersion !== approval.roleVersion ||
        recordScope(
          { userId: required(UserId.parse(approver.id)), role: approver.role, team: null },
          "payment",
          "approve",
        ).kind !== "all"
      )
        throw new AccessError("roleChanged");
    }
    await writeAudit(tx, current, {
      action: "paymentApproved",
      subject: { type: "payment", id: input.id },
      before: { approvals: approvals.length - 1 },
      after: { approvals: approvals.length, roleVersion: user.roleVersion },
      cause: { kind: "request", id: requestId },
      at,
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: row.id,
        kind: "approved",
        at,
        detail: { actorId: current.userId, roleVersion: user.roleVersion, requestId },
      },
    });
    const outcome = await settlePayment(
      tx,
      current,
      row.id,
      { type: "approve", validApprovals: approvals.length },
      requestId,
      at,
    );
    return { id: input.id, ...outcome };
  });
}
export async function decideManualPayment(
  db: Db,
  actor: Actor,
  input: ManualDecision & { readonly reason: string; readonly decision: "reject" | "cancel" },
  requestId: string,
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = await waitingPayment(tx, current, input);
    if (
      row.recordedById !== current.userId &&
      recordScope(current, "payment", "approve").kind !== "all"
    )
      throw new AccessError("accessDenied");
    const at = new Date();
    const before = stateOf(row);
    const next = transitionPayment(
      before,
      { type: input.decision, reason: input.reason },
      money(row.amount, row.currency),
      at,
    );
    if (next === before) throw new AccessError("conflict");
    const updated = await tx.payment.update({ where: { id: row.id }, data: columns(next) });
    await writeAudit(tx, current, {
      action: "paymentStateChanged",
      subject: { type: "payment", id: input.id },
      before: snapshot(row),
      after: snapshot(updated),
      cause: { kind: "request", id: requestId },
      at,
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: row.id,
        kind: updated.status,
        at,
        detail: { actorId: current.userId, reason: updated.reason, requestId },
      },
    });
    return payment(updated);
  });
}
export async function editManualPayment(
  db: Db,
  actor: Actor,
  input: ManualDecision & ManualTerms,
  requestId: string,
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    const row = await waitingPayment(tx, current, input);
    const account = await tx.account.findFirst({
      where: { id: row.accountId, ...scopeWhere(recordScope(current, "payment", "edit")) },
    });
    if (!account) throw new AccessError("accessDenied");
    if (await tx.paymentApproval.findFirst({ where: { paymentId: row.id, voidedAt: null } }))
      throw new AccessError("refreshConflict");
    await availableManualTerms(tx, row.accountId, input.receiptHash, row.id);
    const updated = await tx.payment.update({
      where: { id: row.id },
      data: {
        amount: input.money.minor,
        currency: input.money.currency,
        receiptHash: input.receiptHash,
        reference: input.reference,
        version: { increment: 1 },
      },
    });
    const at = new Date();
    await writeAudit(tx, current, {
      action: "paymentEdited",
      subject: { type: "payment", id: input.id },
      before: {
        ...snapshot(row),
        receiptHash: row.receiptHash,
        reference: row.reference,
        version: row.version,
      },
      after: {
        ...snapshot(updated),
        receiptHash: updated.receiptHash,
        reference: updated.reference,
        version: updated.version,
      },
      cause: { kind: "request", id: requestId },
      at,
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: row.id,
        kind: "edited",
        at,
        detail: { actorId: current.userId, requestId, version: updated.version },
      },
    });
    return payment(updated);
  });
}
async function approvalDetail(tx: Tx, actor: Actor, row: Payment) {
  const recordedBy = await tx.user.findUnique({
    where: { id: row.recordedById },
    select: { id: true, name: true },
  });
  const ownUser = required(await tx.user.findUnique({ where: { id: actor.userId } }));
  const approvals = await tx.paymentApproval.findMany({
    where: { paymentId: row.id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
  });
  const users = await tx.user.findMany({
    where: { id: { in: approvals.map((a) => a.approverId) } },
    select: { id: true, name: true, role: true },
  });
  const history = approvals.map((a) => ({
    ...a,
    approver: users.find((u) => u.id === a.approverId),
  }));
  const mayApprove = recordScope(actor, "payment", "approve").kind === "all";
  const refusal =
    row.recordedById === actor.userId
      ? "paymentRecorder"
      : approvals.some((a) => a.approverId === actor.userId && a.voidedAt === null)
        ? "alreadyApproved"
        : !mayApprove
          ? "accessDenied"
          : row.status !== "pendingApproval"
            ? "refreshConflict"
            : null;
  const mayDecide =
    row.status === "pendingApproval" && (row.recordedById === actor.userId || mayApprove);
  const receipt = await receiptDetail(tx, row.id);
  const editable =
    row.status === "pendingApproval" &&
    !approvals.some((a) => a.voidedAt === null) &&
    (await tx.account.findFirst({
      where: { id: row.accountId, ...scopeWhere(recordScope(actor, "payment", "edit")) },
    }));
  return {
    receipt,
    recordedBy,
    approvals: history,
    cannotApprove: [
      { user: recordedBy, reason: "paymentRecorder" as const, at: row.createdAt },
      ...history
        .filter(
          (a) =>
            a.voidedAt === null ||
            (a.approver !== undefined &&
              recordScope(
                {
                  userId: required(UserId.parse(a.approver.id)),
                  role: a.approver.role,
                  team: null,
                },
                "payment",
                "approve",
              ).kind !== "all"),
        )
        .map((a) => ({
          user: a.approver ?? null,
          reason: a.voidedAt ? ("roleChanged" as const) : ("alreadyApproved" as const),
          at: a.voidedAt ?? a.at,
        })),
    ],
    actions: {
      editManual: Boolean(editable),
      requeueReceipt:
        mayApprove &&
        receipt !== null &&
        ["failed", "unknown"].includes(receipt.state) &&
        !receipt.processing,
      approve: row.method === "manual" && refusal === null,
      approvalRefusal: refusal,
      reject: mayDecide,
      cancel: mayDecide,
      roleVersion: ownUser.roleVersion,
    },
  };
}
