import { randomUUID } from "node:crypto";
import {
  type PaymentId,
  recordScope,
  receiptRetryAt,
  RECEIPT_MAX_ATTEMPTS,
  RECEIPT_LIFETIME_ATTEMPTS,
  RECEIPT_LEASE_MS,
  RECEIPT_SEND_TIMEOUT_MS,
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
  readonly sendTimeoutMs?: number;
  readonly lifetimeAttemptLimit?: number;
  readonly limit?: number;
}
export async function leaseReceipt(
  db: Db,
  id: string,
  at: Date,
  leaseMs: number,
  lifetimeAttemptLimit = RECEIPT_LIFETIME_ATTEMPTS,
) {
  return transact(db, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM outbox WHERE id=${id}::uuid
      AND state IN ('pending','failed') AND cycle_attempts < ${RECEIPT_MAX_ATTEMPTS}
      AND attempts < ${lifetimeAttemptLimit}
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
      : { reason: "no address" };
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
  lifetimeAttemptLimit: number,
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
        nextAttemptAt:
          row.attempts < lifetimeAttemptLimit
            ? receiptRetryAt(outcome.state, row.cycleAttempts, at)
            : null,
      },
    });
    return true;
  });
}
export async function runOutbox(db: Db, deliver: ReceiptDelivery, options: OutboxOptions = {}) {
  const lifetimeAttemptLimit = options.lifetimeAttemptLimit ?? RECEIPT_LIFETIME_ATTEMPTS;
  if (!Number.isSafeInteger(lifetimeAttemptLimit) || lifetimeAttemptLimit < 1)
    throw new Error("Receipt lifetime attempt limit must be a positive integer.");
  const leaseMs = options.leaseMs ?? RECEIPT_LEASE_MS;
  const sendTimeoutMs = options.sendTimeoutMs ?? RECEIPT_SEND_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(leaseMs) ||
    !Number.isSafeInteger(sendTimeoutMs) ||
    sendTimeoutMs <= 0 ||
    sendTimeoutMs >= leaseMs
  )
    throw new Error("Receipt send timeout must be positive and shorter than the lease.");
  const now = () => options.at ?? new Date();
  const candidates = await db.outbox.findMany({
    where: {
      state: { in: ["pending", "failed"] },
      cycleAttempts: { lt: RECEIPT_MAX_ATTEMPTS },
      attempts: { lt: lifetimeAttemptLimit },
      nextAttemptAt: { lte: now() },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now() } }],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    take: options.limit ?? 100,
    select: { id: true, paymentId: true },
  });
  const results: {
    id: string;
    state: DeliveryOutcome["state"] | "superseded" | "recordingFailed";
    failureRecorded?: boolean;
  }[] = [];
  for (const { id, paymentId } of candidates) {
    try {
      const deadline = performance.now() + sendTimeoutMs;
      const lease = await leaseReceipt(db, id, now(), leaseMs, lifetimeAttemptLimit);
      if (!lease?.leaseToken) continue;
      const started = await beginDelivery(db, id, lease.leaseToken, now());
      if (!started) continue;
      if (started.suppressed) {
        results.push({ id, state: "suppressed" });
        continue;
      }
      const payment = await db.payment.findUnique({ where: { id: lease.paymentId } });
      if (!payment) throw new InvariantError("A receipt has no payment");
      const controller = new AbortController();
      const timeout: DeliveryOutcome = {
        state: "unknown",
        reason: "Delivery exceeded its send timeout. The receipt may have arrived.",
      };
      const remaining = deadline - performance.now();
      let outcome: DeliveryOutcome = timeout;
      if (remaining > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          outcome = await Promise.race([
            deliver(
              {
                id,
                paymentId: payment.id,
                email: lease.recipient,
                amount: payment.amount.toString(),
                currency: payment.currency,
              },
              controller.signal,
            ),
            new Promise<DeliveryOutcome>((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve(timeout);
              }, remaining);
            }),
          ]);
        } catch {
          outcome = {
            state: "unknown",
            reason: "Delivery stopped before a confirmed outcome was recorded.",
          };
        } finally {
          clearTimeout(timer);
        }
      }
      const recorded = await finishDelivery(
        db,
        id,
        lease.leaseToken,
        started.attempt.id,
        outcome,
        now(),
        lifetimeAttemptLimit,
      );
      results.push({ id, state: recorded ? outcome.state : "superseded" });
    } catch {
      let failureRecorded = false;
      try {
        await transact(db, (tx) =>
          tx.paymentEvent.create({
            data: {
              paymentId,
              kind: "receiptRecordingFailed",
              at: now(),
              detail: { outboxId: id, reason: "Could not record receipt delivery outcome." },
            },
          }),
        );
        failureRecorded = true;
      } catch {
        // A database outage also prevents recording the failure. Keep it in the worker result.
      }
      results.push({ id, state: "recordingFailed", failureRecorded });
    }
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
export async function requeueReceipt(
  db: Db,
  actor: Actor,
  id: PaymentId,
  requestId: string,
  lifetimeAttemptLimit = RECEIPT_LIFETIME_ATTEMPTS,
) {
  return transact(db, async (tx) => {
    const current = await currentActor(tx, actor);
    if (recordScope(current, "payment", "requeueReceipt").kind !== "all")
      throw new AccessError("accessDenied");
    const at = new Date();
    const row = await tx.outbox.findUnique({ where: { paymentId: id } });
    if (!row) throw new AccessError("accessDenied");
    if (row.attempts >= lifetimeAttemptLimit) throw new AccessError("receiptAttemptLimit");
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
