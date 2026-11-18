import { describe, expect, it } from "vitest";
import { sessionTransition } from "../src/core/session.ts";
import type { Credential, Session } from "../src/core/session.ts";

const credential: Credential = {
  token: "opaque",
  expiresAt: "2026-11-17T14:00:00.000Z",
  user: { id: "agent", name: "Dele Akinwale", role: "agent" },
};
const signedIn: Session = { kind: "signedIn", credential, email: "dele@example.com" };
describe("session transitions", () => {
  it("restores no token as signed out", () => {
    expect(
      sessionTransition(
        { kind: "restoring" },
        { type: "restored", credential: null, email: "saved@example.com", now: 0 },
      ),
    ).toEqual({ kind: "signedOut", email: "saved@example.com" });
  });
  it("checks a restored token before showing private data", () => {
    expect(
      sessionTransition(
        { kind: "restoring" },
        { type: "restored", credential, email: "dele@example.com", now: 0 },
      ).kind,
    ).toBe("checking");
  });
  it("ends an expired token at launch", () => {
    expect(
      sessionTransition(
        { kind: "restoring" },
        {
          type: "restored",
          credential,
          email: "dele@example.com",
          now: new Date(credential.expiresAt).getTime(),
        },
      ),
    ).toEqual({ kind: "ended", personId: "agent", email: "dele@example.com" });
  });
  it("does not call a server outage an ended session", () => {
    const unavailable = sessionTransition(
      { ...signedIn, kind: "checking" },
      { type: "unavailable" },
    );
    expect(unavailable).toEqual({ ...signedIn, kind: "unavailable", failure: { kind: "network" } });
    expect(sessionTransition(unavailable, { type: "verified" })).toEqual(signedIn);
  });
  it("keeps the person's email and identity after a 401", () => {
    expect(sessionTransition(signedIn, { type: "ended" })).toEqual({
      kind: "ended",
      email: "dele@example.com",
      personId: "agent",
    });
  });
  it("accepts a new sign-in after expiry", () => {
    expect(
      sessionTransition(sessionTransition(signedIn, { type: "ended" }), {
        type: "authenticated",
        credential,
        email: "dele@example.com",
      }),
    ).toEqual(signedIn);
  });
  it("clears the previous person and email at sign out", () => {
    expect(sessionTransition(signedIn, { type: "signedOut" })).toEqual({
      kind: "signedOut",
      email: "",
    });
  });
  it.each(["verified", "unavailable", "ended"] as const)(
    "does not authenticate a signed-out person on %s",
    (type) => {
      expect(sessionTransition({ kind: "signedOut", email: "" }, { type })).toEqual({
        kind: "signedOut",
        email: "",
      });
    },
  );
});
