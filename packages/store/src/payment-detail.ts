import {
  recordScope,
  scopeAdmits,
  UserId,
  type Actor,
  type AccessFailure,
  type Role,
  type TeamId,
} from "@relay/domain";
import type { Payment, PaymentApproval, ReceiptAttempt } from "./generated/client.ts";
import type { Tx } from "./tx.ts";
import { InvariantError } from "./lead-row.ts";

export interface Person {
  readonly id: string;
  readonly name: string;
}
interface ApprovalRead {
  readonly id: string;
  readonly recordedBy: Person | null;
  readonly roleVersion: number;
  readonly ownerId: UserId | null;
  readonly teamId: TeamId | null;
  readonly approvals: (Omit<PaymentApproval, "at" | "voidedAt"> & {
    at: string;
    voidedAt: string | null;
    approver?: Person & { role: Role };
  })[];
  readonly makers: { userId: string; at: string; user: Person | null }[];
  readonly receipt: null | {
    id: string;
    processing: boolean;
    recipient: string | null;
    state: string;
    attempts: number;
    cycleAttempts: number;
    nextAttemptAt: string | null;
    history: (Omit<ReceiptAttempt, "startedAt" | "finishedAt"> & {
      startedAt: string;
      finishedAt: string | null;
    })[];
  };
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new InvariantError("Invalid payment detail");
  return value;
}
export async function approvalDetails(
  tx: Tx,
  actor: Actor,
  rows: readonly Payment[],
  lifetimeAttemptLimit: number,
) {
  const details = await tx.$queryRaw<ApprovalRead[]>`
    SELECT p.id, jsonb_build_object('id', recorder.id, 'name', recorder.name) AS "recordedBy",
      own.role_version AS "roleVersion", account.owner_id AS "ownerId", account.team_id AS "teamId",
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'paymentId', a.payment_id, 'approverId', a.approver_id, 'requestId', a.request_id,
        'roleVersion', a.role_version, 'paymentVersion', a.payment_version, 'at', a.at, 'voidedAt', a.voided_at,
        'approver', jsonb_build_object('id', u.id, 'name', u.name, 'role', u.role)) ORDER BY a.at, a.id)
        FROM payment_approvals a JOIN users u ON u.id=a.approver_id WHERE a.payment_id=p.id), '[]') AS approvals,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('userId', m.user_id, 'at', m.at,
        'user', jsonb_build_object('id', u.id, 'name', u.name)) ORDER BY m.at, m.user_id)
        FROM payment_makers m JOIN users u ON u.id=m.user_id WHERE m.payment_id=p.id), '[]') AS makers,
      CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', o.id, 'processing', COALESCE(o.lease_until>now(), false), 'recipient', o.recipient,
        'state', o.state, 'attempts', o.attempts, 'cycleAttempts', o.cycle_attempts, 'nextAttemptAt', o.next_attempt_at,
        'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'outboxId', r.outbox_id,
          'number', r.number, 'state', r.state, 'reason', r.reason, 'startedAt', r.started_at, 'finishedAt', r.finished_at)
          ORDER BY r.started_at, r.number) FROM receipt_attempts r WHERE r.outbox_id=o.id), '[]')) END AS receipt
    FROM payments p JOIN accounts account ON account.id=p.account_id
    JOIN users recorder ON recorder.id=p.recorded_by_id
    JOIN users own ON own.id=${actor.userId}::uuid
    LEFT JOIN outbox o ON o.payment_id=p.id
    WHERE p.id=ANY(${rows.map((row) => row.id)}::uuid[])
  `;
  return new Map(
    rows.map((row) => [
      row.id,
      approvalDetail(
        actor,
        row,
        required(details.find((detail) => detail.id === row.id)),
        lifetimeAttemptLimit,
      ),
    ]),
  );
}

function approvalDetail(
  actor: Actor,
  row: Payment,
  detail: ApprovalRead,
  lifetimeAttemptLimit: number,
) {
  const { recordedBy, roleVersion } = detail;
  const history = detail.approvals.map((entry) => ({
    ...entry,
    at: new Date(entry.at),
    voidedAt: entry.voidedAt ? new Date(entry.voidedAt) : null,
  }));
  const makers = detail.makers.map((entry) => ({ ...entry, at: new Date(entry.at) }));
  const maker = makers.some((entry) => entry.userId === actor.userId);
  const mayApprove = recordScope(actor, "payment", "approve").kind === "all";
  const refusal: AccessFailure | null =
    row.recordedById === actor.userId
      ? "paymentRecorder"
      : maker
        ? "paymentMaker"
        : history.some((a) => a.approverId === actor.userId && a.voidedAt === null)
          ? "alreadyApproved"
          : !mayApprove
            ? "accessDenied"
            : row.status !== "pendingApproval"
              ? "refreshConflict"
              : null;
  const waiting = row.status === "pendingApproval";
  const receipt = detail.receipt
    ? {
        ...detail.receipt,
        nextAttemptAt: detail.receipt.nextAttemptAt ? new Date(detail.receipt.nextAttemptAt) : null,
        history: detail.receipt.history.map((entry) => ({
          ...entry,
          startedAt: new Date(entry.startedAt),
          finishedAt: entry.finishedAt ? new Date(entry.finishedAt) : null,
        })),
      }
    : null;
  const editable =
    row.status === "pendingApproval" && scopeAdmits(recordScope(actor, "payment", "edit"), detail);
  return {
    receipt,
    receiptAttemptLimit: lifetimeAttemptLimit,
    recordedBy,
    approvals: history,
    cannotApprove: [
      { user: recordedBy, reason: "paymentRecorder" as const, at: row.createdAt },
      ...makers
        .filter((entry) => entry.userId !== row.recordedById)
        .map((entry) => ({
          user: entry.user,
          reason: "paymentMaker" as const,
          at: entry.at,
        })),
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
      closeReview:
        row.status === "needsReview" && recordScope(actor, "payment", "closeReview").kind === "all",
      closeCheckout:
        row.status === "checkoutCreated" &&
        scopeAdmits(recordScope(actor, "account", "edit"), detail),
      editManual: editable,
      requeueReceipt:
        mayApprove &&
        receipt !== null &&
        ["failed", "unknown"].includes(receipt.state) &&
        !receipt.processing &&
        receipt.attempts < lifetimeAttemptLimit,
      approve: row.method === "manual" && refusal === null,
      approvalRefusal: refusal,
      reject: waiting && mayApprove && !maker,
      cancel: waiting && row.recordedById === actor.userId,
      roleVersion,
    },
  };
}
