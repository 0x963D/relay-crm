import { ACCESS_FAILURES, type AccessFailure } from "@relay/domain";
export const failureMessages: Record<AccessFailure, string> = {
  accessDenied:
    "You cannot open this record. Your access or its owner may have changed. Go back to your list.",
  leadClosed: "This lead is closed. Refresh to see its history.",
  callbackInPast: "The callback was not saved. Choose a time in the future.",
  callbackNotSet: "This lead has no callback to clear. Refresh to see its current state.",
  wrongNumberNeedsAnAttempt:
    "Try contacting this lead in its current assignment before marking it as a wrong number.",
  invalidTransition: "Log an attempt before closing this lead as won or lost.",
  pendingPayment:
    "This account already has a payment in progress. Open that payment before recording another.",
  receiptUsed:
    "This receipt was already used for a payment. Check that payment or choose a different receipt.",
  receiptAttemptLimit:
    "This receipt has reached its lifetime attempt limit. Check its delivery history before contacting the customer.",
  paymentRecorder:
    "You recorded this payment and cannot approve it. Ask two other approvers to decide.",
  paymentMaker: "You edited this payment and cannot approve it. Ask two other approvers to decide.",
  alreadyApproved:
    "You already approved this payment. A different approver must give the next approval.",
  roleChanged: "Your role changed. Refresh before deciding on this payment.",
  refreshConflict: "This payment changed. Refresh before trying again.",
  conflict:
    "Nothing was changed. The record changed while you were working. Refresh and try again.",
  idempotencyConflict:
    "This request key was already used for different work. Refresh before trying again.",
  teamSelectionRequired: "Choose a current team before opening this list.",
  stalePreview:
    "Nothing was assigned. These leads changed after your preview. Make a new preview from the leads still in the pool.",
  invalidAgent:
    "Nothing was assigned. Choose an agent who still belongs to a sales team, then make a new preview.",
  noEligibleAgent:
    "Nothing was assigned. No selected agent can receive these leads. Change the selection or the previous-owner rule.",
};
export function failureCode(error: unknown): AccessFailure | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("accessFailure" in data)) return null;
  return ACCESS_FAILURES.find((code) => code === data.accessFailure) ?? null;
}
export function failureMessage(error: unknown, operation: "read" | "save" = "save"): string {
  const code = failureCode(error);
  if (code) return failureMessages[code];
  const action = operation === "read" ? "loaded" : "saved";
  if (typeof error === "object" && error !== null && "data" in error && error.data) {
    const data = error.data;
    if (typeof data === "object" && "code" in data && data.code === "UNAUTHORIZED")
      return "Your session ended. Sign in again to continue.";
    if (
      "message" in error &&
      typeof error.message === "string" &&
      typeof data === "object" &&
      !("code" in data)
    )
      return error.message;
    return `The server could not complete the request. This was not ${action}. Try again in a moment.`;
  }
  return `This was not ${action}. The server could not be reached. Check your connection and try again.`;
}
export const authMessages = {
  OTP_EXPIRED: "That code no longer works. It ran out of time. Send a new code.",
  INVALID_OTP: "That code did not work. Check all six digits or ask for a new code.",
  TOO_MANY_ATTEMPTS: "Too many tries. Wait a minute, then ask for a new code.",
  demoUnavailable: "This demo role is unavailable. Choose another role or try after the reset.",
  connection: "The request could not be completed. Check your connection and try again.",
};
export async function authFailure(
  response: Response | null,
  phase: "send" | "code" | "demo",
): Promise<string> {
  if (!response) return authMessages.connection;
  if (response.status >= 500)
    return "The server could not complete sign-in. Try again in a moment.";
  if (response.status === 404) return "Sign-in is unavailable. Ask your manager for help.";
  if (response.status === 429) return authMessages.TOO_MANY_ATTEMPTS;
  if (phase === "demo")
    return response.status === 403
      ? authMessages.demoUnavailable
      : "The demo role could not be opened. Try again in a moment.";
  const payload: unknown = await response.json().catch(() => null);
  if (phase === "code" && typeof payload === "object" && payload !== null && "code" in payload) {
    if (payload.code === "OTP_EXPIRED") return authMessages.OTP_EXPIRED;
    if (payload.code === "TOO_MANY_ATTEMPTS") return authMessages.TOO_MANY_ATTEMPTS;
  }
  return phase === "code"
    ? authMessages.INVALID_OTP
    : "The code could not be sent. Check your email address and try again.";
}
