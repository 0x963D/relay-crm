import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  type PaymentId,
  recordScope,
  receiptRetryAt,
  RECEIPT_MAX_ATTEMPTS,
  type Actor,
  type DeliveryOutcome,
  type ReceiptMessage,
} from "@relay/domain";
import { currentActor } from "./auth.ts";
import { writeAudit } from "./audit.ts";
import { AccessError } from "./errors.ts";
import { InvariantError } from "./lead-row.ts";
import { transact, type Db, type Tx } from "./tx.ts";

export type ReceiptDelivery = (
  message: ReceiptMessage,
  signal: AbortSignal,
) => Promise<DeliveryOutcome>;
export interface OutboxOptions {
  readonly at?: Date;
  readonly leaseMs?: number;
  readonly limit?: number;
}
export async function leaseReceipt(db: Db, id: string, at: Date, leaseMs: number) {
  return transact(db, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM outbox WHERE id=${id}::uuid
      AND state IN ('pending','failed') AND cycle_attempts < ${RECEIPT_MAX_ATTEMPTS}
      AND next_attempt_at <= ${at} AND (lease_until IS NULL OR lease_until <= ${at})
      FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return null;
    return tx.outbox.update({
      where: { id },
      data: { leaseToken: randomUUID(), leaseUntil: new Date(at.getTime() + leaseMs) },
    });
  });
}
async function beginDelivery(db: Db, id: string, token: string, at: Date) {
  return transact(db, async (tx) => {
    const row = await tx.outbox.findFirst({
      where: {
        id,
        leaseToken: token,
        leaseUntil: { gt: at },
        state: { in: ["pending", "failed"] },
      },
    });
    if (!row) return null;
    const suppression = row.recipient
      ? await tx.emailSuppression.findUnique({ where: { email: row.recipient } })
      : null;
    const number = suppression ? row.attempts : row.attempts + 1;
    const outcome = suppression ? "suppressed" : "unknown";
    const reason = suppression?.reason ?? "Delivery began without a confirmed outcome.";
    await tx.outbox.update({
      where: { id },
      data: {
        state: outcome,
        nextAttemptAt: null,
        ...(suppression
          ? { leaseToken: null, leaseUntil: null }
          : { attempts: number, cycleAttempts: { increment: 1 } }),
      },
    });
    const attempt = await tx.receiptAttempt.create({
      data: {
        outboxId: id,
        number: suppression ? 0 : number,
        state: outcome,
        reason,
        startedAt: at,
        finishedAt: suppression ? at : null,
      },
    });
    if (suppression) return { suppressed: true as const, attempt, row };
    return {
      suppressed: false as const,
      attempt,
      row: { ...row, attempts: number, cycleAttempts: row.cycleAttempts + 1 },
    };
  });
}
async function finishDelivery(
  db: Db,
  id: string,
  token: string,
  attemptId: string,
  outcome: DeliveryOutcome,
  at: Date,
) {
  return transact(db, async (tx) => {
    const row = await tx.outbox.findFirst({ where: { id, leaseToken: token } });
    if (!row) return false;
    await tx.receiptAttempt.update({
      where: { id: attemptId },
      data: {
        state: outcome.state,
        reason: "reason" in outcome ? outcome.reason : null,
        finishedAt: at,
      },
    });
    await tx.outbox.update({
      where: { id },
      data: {
        state: outcome.state,
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: receiptRetryAt(outcome.state, row.cycleAttempts, at),
      },
    });
    return true;
  });
}
export async function runOutbox(
  db: Db,
  connectionString: string,
  deliver: ReceiptDelivery,
  options: OutboxOptions = {},
) {
  const now = () => options.at ?? new Date();
  const candidates = await db.outbox.findMany({
    where: {
      state: { in: ["pending", "failed"] },
      cycleAttempts: { lt: RECEIPT_MAX_ATTEMPTS },
      nextAttemptAt: { lte: now() },
    },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: options.limit ?? 100,
    select: { id: true },
  });
  const session = new pg.Client({ connectionString });
  const controller = new AbortController();
  session.on("error", () => {
    controller.abort();
  });
  await session.connect();
  const results: { id: string; state: DeliveryOutcome["state"] }[] = [];
  try {
    for (const { id } of candidates) {
      controller.signal.throwIfAborted();
      // The session lock outlives the lease while SMTP is running, without holding a transaction open.
      const locked = await session.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended('receipt:' || $1,0)) AS locked",
        [id],
      );
      if (!locked.rows[0]?.locked) continue;
      try {
        const lease = await leaseReceipt(db, id, now(), options.leaseMs ?? 60_000);
        if (!lease?.leaseToken) continue;
        controller.signal.throwIfAborted();
        const started = await beginDelivery(db, id, lease.leaseToken, now());
        if (!started) continue;
        if (started.suppressed) {
          results.push({ id, state: "suppressed" });
          continue;
        }
        const payment = await db.payment.findUnique({ where: { id: lease.paymentId } });
        if (!payment) throw new InvariantError("A receipt has no payment");
        let outcome: DeliveryOutcome;
        try {
          controller.signal.throwIfAborted();
          outcome = await deliver(
            {
              id,
              paymentId: payment.id,
              email: lease.recipient,
              amount: payment.amount.toString(),
              currency: payment.currency,
            },
            controller.signal,
          );
        } catch {
          outcome = {
            state: "unknown",
            reason: "Delivery stopped before a confirmed outcome was recorded.",
          };
        }
        await finishDelivery(db, id, lease.leaseToken, started.attempt.id, outcome, now());
        results.push({ id, state: outcome.state });
      } finally {
        if (!controller.signal.aborted)
          await session.query("SELECT pg_advisory_unlock(hashtextextended('receipt:' || $1,0))", [
            id,
          ]);
      }
    }
  } finally {
    await session.end();
  }
  return results;
}
export async function receiptDetail(tx: Tx, paymentId: string) {
  const row = await tx.outbox.findUnique({ where: { paymentId } });
  if (!row) return null;
  const history = await tx.receiptAttempt.findMany({
    where: { outboxId: row.id },
    orderBy: [{ startedAt: "asc" }, { number: "asc" }],
  });
  return {
    id: row.id,
    processing: row.leaseUntil !== null && row.leaseUntil > new Date(),
    recipient: row.recipient,
    state: row.state,
    attempts: row.attempts,
    cycleAttempts: row.cycleAttempts,
    nextAttemptAt: row.nextAttemptAt,
    history,
  };
}
export async function requeueReceipt(db: Db, actor: Actor, id: PaymentId, requestId: string) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    if (recordScope(current, "payment", "requeueReceipt").kind !== "all")
      throw new AccessError("accessDenied");
    const at = new Date();
    const row = await tx.outbox.findUnique({ where: { paymentId: id } });
    if (!row) throw new AccessError("accessDenied");
    if (
      !["failed", "unknown"].includes(row.state) ||
      (row.leaseUntil !== null && row.leaseUntil > at)
    )
      throw new AccessError("refreshConflict");
    await tx.outbox.update({
      where: { id: row.id },
      data: {
        state: "pending",
        cycleAttempts: 0,
        nextAttemptAt: at,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    await writeAudit(tx, current, {
      action: "receiptRequeued",
      subject: { type: "payment", id },
      before: { state: row.state, attempts: row.attempts },
      after: { state: "pending", attempts: row.attempts },
      cause: { kind: "request", id: requestId },
      at,
    });
    await tx.paymentEvent.create({
      data: {
        paymentId: id,
        kind: "receiptRequeued",
        at,
        detail: { actorId: current.userId, requestId, previousState: row.state },
      },
    });
    return receiptDetail(tx, id);
  });
}
