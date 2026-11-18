import { expect, it, vi } from "vitest";
import { signOutFromPhone } from "../src/core/sign-out.ts";
import { sessionDisplay, signInOptions } from "../src/core/session-display.ts";

it("deletes the token only after confirmed revocation, then forgets the cache", async () => {
  const order: string[] = [];
  await signOutFromPhone({
    revoke: () => {
      order.push("revoke");
      return Promise.resolve();
    },
    remove: () => {
      order.push("token");
      return Promise.resolve(true);
    },
    erase: () => {
      order.push("phone");
      return Promise.resolve();
    },
    forget: () => {
      order.push("cache");
    },
  });
  expect(order).toEqual(["revoke", "token", "phone", "cache"]);
});
it("keeps everything when sign-out cannot be confirmed", async () => {
  const remove = vi.fn();
  const forget = vi.fn();
  await expect(
    signOutFromPhone({
      revoke: () => Promise.reject(new Error("no answer")),
      remove,
      erase: vi.fn(),
      forget,
    }),
  ).rejects.toThrow("no answer");
  expect(remove).not.toHaveBeenCalled();
  expect(forget).not.toHaveBeenCalled();
});
it("removes sign-in locally with no server request", async () => {
  const revoke = vi.fn();
  const remove = vi.fn().mockResolvedValue(true);
  const forget = vi.fn();
  const erase = vi.fn().mockResolvedValue(undefined);
  await signOutFromPhone({ revoke, remove, erase, forget }, true);
  expect(revoke).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
  expect(erase).toHaveBeenCalledOnce();
  expect(forget).toHaveBeenCalledOnce();
});
it("does not clear cached state when token removal fails", async () => {
  const forget = vi.fn();
  await expect(
    signOutFromPhone(
      {
        revoke: vi.fn(),
        remove: () => Promise.reject(new Error("storage")),
        erase: vi.fn(),
        forget,
      },
      true,
    ),
  ).rejects.toThrow("storage");
  expect(forget).not.toHaveBeenCalled();
});
it("does not forget a newer person's state after an old sign-out finishes", async () => {
  const forget = vi.fn();
  await signOutFromPhone({
    revoke: () => Promise.resolve(),
    remove: () => Promise.resolve(false),
    erase: vi.fn(),
    forget,
  });
  expect(forget).not.toHaveBeenCalled();
});
it.each(["form", "review", "result"] as const)("presents sign-in over an ended %s", (surface) => {
  expect(
    sessionDisplay({ kind: "ended", personId: "one", email: "one@example.com" }, surface),
  ).toBe("modal");
});
it("replaces content after the session ends without an open form", () => {
  expect(
    sessionDisplay({ kind: "ended", personId: "one", email: "one@example.com" }, "content"),
  ).toBe("replacement");
});
it("redirects a live session away from a second sign-in", () => {
  expect(
    signInOptions(
      {
        kind: "signedIn",
        email: "person@example.com",
        credential: {
          token: "token",
          expiresAt: "2026-11-18T00:00:00Z",
          user: { id: "person", name: "Person", role: "agent" },
        },
      },
      true,
    ).allowed,
  ).toBe(false);
});
it("leaves an ended launch email blank and offers removal while retaining modal recovery", () => {
  const ended = { kind: "ended", personId: "person", email: "previous@example.com" } as const;
  expect(signInOptions(ended, false)).toEqual({ allowed: true, email: "", remove: true });
  expect(signInOptions(ended, true)).toEqual({
    allowed: true,
    email: "previous@example.com",
    remove: false,
  });
});
