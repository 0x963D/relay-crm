export type DeliveryOutcome =
  | { readonly state: "sent" }
  | { readonly state: "failed" | "unknown" | "suppressed"; readonly reason: string };
export interface ReceiptMessage {
  readonly id: string;
  readonly paymentId: string;
  readonly email: string | null;
  readonly amount: string;
  readonly currency: string;
}
export const RECEIPT_RETRY_MINUTES = [5, 10, 20] as const;
export const RECEIPT_MAX_ATTEMPTS = RECEIPT_RETRY_MINUTES.length + 1;
export function receiptRetryAt(
  outcome: DeliveryOutcome["state"],
  attempts: number,
  at: Date,
): Date | null {
  const minutes = RECEIPT_RETRY_MINUTES[attempts - 1];
  return outcome === "failed" && minutes !== undefined
    ? new Date(at.getTime() + minutes * 60_000)
    : null;
}

export const RECEIPT_LEASE_MS = 60_000;
export const RECEIPT_SEND_TIMEOUT_MS = 30_000;
export const RECEIPT_LIFETIME_ATTEMPTS = 12;
