import { z } from "zod";
import type { Failure } from "./failure.ts";

export const credentialSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  user: z.object({ id: z.string(), name: z.string(), role: z.string() }),
});
export interface Credential {
  readonly token: string;
  readonly expiresAt: string;
  readonly user: { readonly id: string; readonly name: string; readonly role: string };
}

export type Session =
  | { readonly kind: "restoring" }
  | { readonly kind: "signedOut"; readonly email: string }
  | { readonly kind: "checking"; readonly credential: Credential; readonly email: string }
  | {
      readonly kind: "unavailable";
      readonly credential: Credential;
      readonly email: string;
      readonly failure: Failure;
    }
  | { readonly kind: "signedIn"; readonly credential: Credential; readonly email: string }
  | { readonly kind: "ended"; readonly personId: string; readonly email: string };

export type SessionEvent =
  | { readonly type: "email"; readonly email: string }
  | {
      readonly type: "restored";
      readonly credential: Credential | null;
      readonly email: string;
      readonly now: number;
    }
  | { readonly type: "authenticated"; readonly credential: Credential; readonly email: string }
  | { readonly type: "verified" }
  | { readonly type: "unavailable"; readonly failure?: Failure }
  | { readonly type: "ended" }
  | { readonly type: "signedOut" };

export function sessionPerson(state: Session): string | null {
  return "credential" in state
    ? state.credential.user.id
    : state.kind === "ended"
      ? state.personId
      : null;
}

export function sessionTransition(state: Session, event: SessionEvent): Session {
  switch (event.type) {
    case "email":
      return "email" in state ? { ...state, email: event.email } : state;
    case "restored":
      if (!event.credential) return { kind: "signedOut", email: event.email };
      return new Date(event.credential.expiresAt).getTime() <= event.now
        ? { kind: "ended", personId: event.credential.user.id, email: event.email }
        : { kind: "checking", credential: event.credential, email: event.email };
    case "authenticated":
      return { kind: "signedIn", credential: event.credential, email: event.email };
    case "verified":
      return "credential" in state
        ? { kind: "signedIn", credential: state.credential, email: state.email }
        : state;
    case "unavailable":
      return "credential" in state
        ? {
            kind: "unavailable",
            credential: state.credential,
            email: state.email,
            failure: event.failure ?? { kind: "network" },
          }
        : state;
    case "ended":
      return "credential" in state
        ? { kind: "ended", personId: state.credential.user.id, email: state.email }
        : state;
    case "signedOut":
      return { kind: "signedOut", email: "" };
  }
}
