import { CURRENCIES, isCurrencyCode, type Money, type PaymentState } from "@relay/domain";
import type { Outputs } from "./api";

export type PaymentView = Outputs["payments"]["get"];
export type PaymentRow = Outputs["payments"]["list"]["waitingForApproval"][number];
export function receiptPresentation(
  receipt: Pick<NonNullable<PaymentView["receipt"]>, "processing" | "state" | "nextAttemptAt">,
  now: number,
) {
  const nextAttemptAt =
    !receipt.processing &&
    receipt.state === "failed" &&
    receipt.nextAttemptAt &&
    receipt.nextAttemptAt.getTime() > now
      ? receipt.nextAttemptAt
      : null;
  return {
    outcome: receipt.processing
      ? ("sending" as const)
      : receipt.state === "failed" && receipt.nextAttemptAt
        ? nextAttemptAt
          ? ("scheduled" as const)
          : ("queued" as const)
        : receipt.state,
    explainUnknown: !receipt.processing && receipt.state === "unknown",
    nextAttemptAt,
  };
}
export const paymentGroups = [
  ["needsReview", "Needs review"],
  ["waitingForApproval", "Waiting for approval"],
  ["waitingForProvider", "Waiting for the provider"],
  ["decidedThisWeek", "Decided this week"],
] as const;
export function paymentStatus(payment: {
  state: PaymentState;
  approvals: PaymentView["approvals"];
}) {
  const status = payment.state.status;
  if (status === "pendingApproval")
    return `Waiting · ${String(payment.approvals.filter((a) => !a.voidedAt).length)} of 2`;
  if (status === "checkoutCreated") return "Waiting for the provider";
  if (status === "needsReview") return "Needs review";
  return status.charAt(0).toUpperCase() + status.slice(1);
}
export function completedBy(by: string) {
  return by === "providerWebhook"
    ? "The webhook"
    : by === "reconciler"
      ? "The reconciler"
      : "Two approvers";
}
export function parseAmount(value: string, currency: string): Money | null {
  if (!isCurrencyCode(currency) || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const [whole = "0", fraction = ""] = value.trim().split(".");
  const digits = CURRENCIES[currency];
  if (fraction.length > digits) return null;
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  return minor > 0n && minor <= 9223372036854775806n ? { minor, currency } : null;
}
export function amountInput(money: Money) {
  const digits = CURRENCIES[money.currency];
  const factor = 10n ** BigInt(digits);
  return `${String(money.minor / factor)}${digits ? `.${String(money.minor % factor).padStart(digits, "0")}` : ""}`;
}
export function eventDetail(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
export function reportedMoney(value: Record<string, unknown>): Money | null {
  return typeof value.reportedAmount === "string" &&
    /^\d+$/.test(value.reportedAmount) &&
    typeof value.reportedCurrency === "string" &&
    isCurrencyCode(value.reportedCurrency)
    ? { minor: BigInt(value.reportedAmount), currency: value.reportedCurrency }
    : null;
}

export function groupPaymentEvents<
  T extends Pick<PaymentView["events"][number], "kind" | "at" | "detail">,
>(events: readonly T[]) {
  const groups: { event: T; count: number; lastAt: Date }[] = [];
  for (const event of events) {
    const last = groups.at(-1);
    const detail = eventDetail(event.detail);
    const prior = eventDetail(last?.event.detail);
    if (
      last &&
      event.kind === "reconcilerCheck" &&
      last.event.kind === event.kind &&
      detail.changed === false &&
      prior.changed === false &&
      [
        "providerStatus",
        "status",
        "error",
        "superseded",
        "reportedAmount",
        "reportedCurrency",
      ].every((key) => detail[key] === prior[key])
    ) {
      last.count += 1;
      last.lastAt = event.at;
    } else groups.push({ event, count: 1, lastAt: event.at });
  }
  return groups;
}
