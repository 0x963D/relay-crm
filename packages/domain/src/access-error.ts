import type { AccessFailure } from "./distribution.ts";

export class AccessError extends Error {
  override readonly name = "AccessError";
  readonly code: AccessFailure;
  constructor(code: AccessFailure) {
    const messages: Partial<Record<AccessFailure, string>> = {
      accessDenied: "You do not have access to this record.",
      leadClosed: "This lead is closed. Refresh to see its history.",
      wrongNumberNeedsAnAttempt:
        "Try contacting this lead in its current assignment before marking it as a wrong number.",
      callbackNotSet: "This lead has no callback to clear.",
      callbackInPast: "Choose a callback time in the future.",
      invalidTransition: "Work this lead before closing it as won or lost.",
      pendingPayment: "This account already has a payment in progress.",
      receiptAttemptLimit: "This receipt has reached its lifetime attempt limit.",
      receiptUsed: "This receipt was already used for a payment.",
      paymentMaker: "You edited this payment and cannot approve it.",
      paymentRecorder: "You recorded this payment and cannot approve it.",
      alreadyApproved: "You already approved this payment.",
      roleChanged: "Your role changed. Refresh before deciding on this payment.",
      refreshConflict: "This payment changed. Refresh before trying again.",
    };
    super(
      messages[code] ??
        (code === "idempotencyConflict"
          ? "The key was already used for a different request."
          : code === "teamSelectionRequired"
            ? "Choose a current team before using team-scoped operations."
            : code),
    );
    this.code = code;
  }
}
