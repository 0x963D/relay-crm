import type { Money } from "./money.ts";

export type SettlementCaller = "providerWebhook" | "reconciler" | "manualApproval";
export type PaymentState =
  | { readonly status: "checkoutCreated" }
  | { readonly status: "pendingApproval" }
  | { readonly status: "rejected" | "cancelled"; readonly reason: string; readonly at: Date }
  | { readonly status: "completed"; readonly by: SettlementCaller; readonly at: Date }
  | {
      readonly status: "needsReview";
      readonly reported: Money;
      readonly reason: "amount mismatch" | "currency mismatch" | "paid after close";
      readonly at: Date;
    }
  | { readonly status: "failed"; readonly reason: string; readonly at: Date }
  | { readonly status: "expired"; readonly at: Date };
export type PaymentStatus = PaymentState["status"];
export type ProviderStatus = "pending" | "completed" | "failed" | "expired";
export type ProviderPayment =
  | { readonly status: "missing" }
  | {
      readonly status: ProviderStatus;
      readonly money: Money;
    };
export type PaymentEvent =
  | {
      readonly type: "provider";
      readonly result: ProviderPayment;
      readonly by: Exclude<SettlementCaller, "manualApproval">;
    }
  | { readonly type: "approve"; readonly validApprovals: number }
  | { readonly type: "reject" | "cancel"; readonly reason: string }
  | { readonly type: "closeReview" | "closeCheckout"; readonly reason: string };

type Rule = (state: PaymentState, event: PaymentEvent, expected: Money, at: Date) => PaymentState;
const paidAfterClose: Rule = (state, event, _expected, at) =>
  event.type === "provider" && event.result.status === "completed"
    ? { status: "needsReview", reason: "paid after close", reported: event.result.money, at }
    : state;
const RULES: Readonly<
  Record<PaymentStatus, Readonly<Partial<Record<PaymentEvent["type"], Rule | null>>>>
> = {
  checkoutCreated: {
    provider: (state, event, expected, at) => {
      if (event.type !== "provider") return state;
      if (event.result.status === "missing")
        return { status: "failed", reason: "the checkout was never created at the provider", at };
      const { status, money } = event.result;
      if (money.minor !== expected.minor || money.currency !== expected.currency)
        return {
          status: "needsReview",
          reason: money.currency !== expected.currency ? "currency mismatch" : "amount mismatch",
          reported: money,
          at,
        };
      switch (status) {
        case "pending":
          return state;
        case "completed":
          return { status, by: event.by, at };
        case "expired":
          return { status, at };
        case "failed":
          return { status, reason: "The provider reported failure.", at };
      }
    },
    closeReview: null,
    closeCheckout: (state, event, _expected, at) =>
      event.type === "closeCheckout" && event.reason.trim()
        ? { status: "failed", reason: event.reason.trim(), at }
        : state,
  },
  needsReview: {
    provider: null,
    closeReview: (state, event, _expected, at) =>
      event.type === "closeReview" && event.reason.trim().length > 0
        ? { status: "failed", reason: event.reason.trim(), at }
        : state,
  },
  pendingApproval: {
    approve: (state, event, _expected, at) =>
      event.type === "approve" && event.validApprovals === 2
        ? { status: "completed", by: "manualApproval", at }
        : state,
    reject: (state, event, _expected, at) =>
      event.type === "reject" && event.reason.trim()
        ? { status: "rejected", reason: event.reason.trim(), at }
        : state,
    cancel: (state, event, _expected, at) =>
      event.type === "cancel" && event.reason.trim()
        ? { status: "cancelled", reason: event.reason.trim(), at }
        : state,
  },
  rejected: {},
  cancelled: {},
  completed: { provider: null, closeReview: null },
  failed: { provider: paidAfterClose, closeReview: null },
  expired: { provider: paidAfterClose, closeReview: null },
};

export function transitionPayment(
  state: PaymentState,
  event: PaymentEvent,
  expected: Money,
  at: Date,
): PaymentState {
  return RULES[state.status][event.type]?.(state, event, expected, at) ?? state;
}

export const SANDBOX_MODES = ["normal", "drop", "twice", "late", "differentAmount"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export interface PaymentProvider {
  createCheckout(input: {
    readonly paymentId: string;
    readonly creationToken?: string;
    readonly money: Money;
    readonly mode: SandboxMode;
  }): Promise<{ readonly id: string; readonly url: string | null }>;
  readPayment(id: string): Promise<ProviderPayment>;
  cancelCheckout(id: string): Promise<void>;
}
