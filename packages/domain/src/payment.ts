import type { Money } from "./money.ts";

export type SettlementCaller = "providerWebhook" | "reconciler";
export type PaymentState =
  | { readonly status: "checkoutCreated" }
  | { readonly status: "completed"; readonly by: SettlementCaller; readonly at: Date }
  | { readonly status: "needsReview"; readonly reported: Money; readonly at: Date }
  | { readonly status: "failed"; readonly reason: string; readonly at: Date }
  | { readonly status: "expired"; readonly at: Date };
export type PaymentStatus = PaymentState["status"];
export type ProviderStatus = "pending" | "completed" | "failed" | "expired";
export interface ProviderPayment {
  readonly status: ProviderStatus;
  readonly money: Money;
}
export type PaymentEvent =
  | { readonly type: "provider"; readonly result: ProviderPayment; readonly by: SettlementCaller }
  | { readonly type: "closeReview"; readonly reason: string };

type Rule = (state: PaymentState, event: PaymentEvent, expected: Money, at: Date) => PaymentState;
const RULES: Readonly<Record<PaymentStatus, Readonly<Record<PaymentEvent["type"], Rule | null>>>> =
  {
    checkoutCreated: {
      provider: (state, event, expected, at) => {
        if (event.type !== "provider") return state;
        const { status, money } = event.result;
        if (money.minor !== expected.minor || money.currency !== expected.currency)
          return { status: "needsReview", reported: money, at };
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
    },
    needsReview: {
      provider: null,
      closeReview: (state, event, _expected, at) =>
        event.type === "closeReview" && event.reason.trim().length > 0
          ? { status: "failed", reason: event.reason.trim(), at }
          : state,
    },
    completed: { provider: null, closeReview: null },
    failed: { provider: null, closeReview: null },
    expired: { provider: null, closeReview: null },
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
    readonly money: Money;
    readonly mode: SandboxMode;
  }): Promise<{ readonly id: string; readonly url: string }>;
  readPayment(id: string): Promise<ProviderPayment>;
}
