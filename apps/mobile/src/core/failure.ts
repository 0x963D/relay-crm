export type Failure =
  | { readonly kind: "network" }
  | { readonly kind: "noAnswer" }
  | { readonly kind: "sessionEnded"; readonly status: number }
  | { readonly kind: "unreadable"; readonly status: number }
  | { readonly kind: "refused"; readonly status: number; readonly reason: string | null }
  | { readonly kind: "http"; readonly status: number };

export function mapFailure(input: {
  status?: number | undefined;
  code?: string | undefined;
  accessFailure?: string | null | undefined;
  timedOut?: boolean | undefined;
  api?: boolean | undefined;
}): Failure {
  if (input.status !== undefined && input.status >= 200 && input.status < 300)
    return { kind: "unreadable", status: input.status };
  if (input.status !== undefined && input.status >= 500)
    return { kind: "http", status: input.status };
  if (
    (input.status === 401 && (input.api || input.code === "UNAUTHORIZED")) ||
    (input.status === undefined && input.code === "UNAUTHORIZED")
  )
    return { kind: "sessionEnded", status: input.status ?? 401 };
  if (input.accessFailure || (input.api && input.status === 400))
    return { kind: "refused", status: input.status ?? 400, reason: input.accessFailure ?? null };
  if (input.status !== undefined) return { kind: "http", status: input.status };
  return { kind: input.timedOut ? "noAnswer" : "network" };
}

export function failureWording(failure: Failure) {
  switch (failure.kind) {
    case "network":
    case "noAnswer":
      return {
        title: "The server did not answer",
        text: "Check your connection.",
        icon: "offline",
      } as const;
    case "unreadable":
      return {
        title: "The answer could not be read",
        text: "Wait a moment before another try.",
        icon: "help",
      } as const;
    case "http":
      return failure.status >= 500
        ? ({
            title: "The server could not finish this",
            text: "Wait a moment before another try.",
            icon: "help",
          } as const)
        : ({
            title: "The request could not finish",
            text: "Try again. If it keeps happening, ask your manager for help.",
            icon: "help",
          } as const);
    case "refused":
      return {
        title: "The server refused this request",
        text: "Ask your manager for help.",
        icon: "error",
      } as const;
    case "sessionEnded":
      return {
        title: "Your session ended",
        text: "Sign in again to pick up where you were.",
        icon: "lock",
      } as const;
  }
}

export class RequestFailure extends Error {
  readonly failure: Failure;
  readonly code: string | undefined;
  readonly retryAfter: number | undefined;
  constructor(failure: Failure, code?: string, retryAfter?: number) {
    super(failure.kind);
    this.failure = failure;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function retrySeconds(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return 60;
  return Math.max(0, Number(value));
}

export function remainingSeconds(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function readFailureText(failure: Failure) {
  if (failure.kind === "network" || failure.kind === "noAnswer")
    return "No reply from the server. Check your connection.";
  const words = failureWording(failure);
  return `${words.title}. ${words.text}`;
}
