import { afterEach, expect, it, vi } from "vitest";
import superjson from "superjson";
import { createClient } from "../src/api/client.ts";
import { writeRequest } from "../src/api/write-request.ts";
import { PhoneEntries } from "../src/core/phone-entries.ts";
import { erasePhone, signOutFromPhone } from "../src/core/sign-out.ts";
import type { Command, Scope } from "../src/core/write-model.ts";
import type { Fetch } from "../src/core/request.ts";
import { command, draft, FakePhone, flush, id, key, now, scope } from "./write-fixtures.ts";

vi.mock("../src/api/token.ts", () => ({ bearer: () => null }));
afterEach(() => vi.useRealTimers());
function requester(fetch: Fetch, sessionEnded = vi.fn()) {
  return writeRequest(
    createClient({ origin: scope.server, fetch, token: () => "token", sessionEnded }).rpc,
  );
}
const unauthorized = () =>
  Response.json(
    {
      error: {
        json: {
          message: "Unauthorized",
          code: -32001,
          data: { code: "UNAUTHORIZED", httpStatus: 401 },
        },
      },
    },
    { status: 401 },
  );
it("a rejected fetch after dispatch becomes outcome unknown and keeps the key", async () => {
  const storage = new FakePhone();
  const fetch = vi.fn(() => Promise.reject(new TypeError("Connection reset after sending")));
  const owner = new PhoneEntries({
    reportError: vi.fn(),
    scope,
    storage,
    identity: () => scope,
    dispatch: requester(fetch),
    now: () => now,
  });
  await owner.restore();
  await owner.save(command, draft, false);
  await vi.waitFor(() => {
    expect(owner.snapshot(id).state).toBe("unknown");
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(storage.saved().entries[id]).toMatchObject({ command, status: "unknown", attempt: 1 });
});
it("a timeout leaves fetch open and a late receipt settles the unknown entry", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const response = Promise.withResolvers<Response>();
  const storage = new FakePhone();
  const owner = new PhoneEntries({
    reportError: vi.fn(),
    scope,
    storage,
    identity: () => scope,
    dispatch: requester((_input, init) => {
      signal = init?.signal;
      return response.promise;
    }),
    now: () => now,
  });
  await owner.restore();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(139999);
  expect(signal?.aborted).toBe(false);
  expect(owner.snapshot(id)).toMatchObject({
    state: "unknown",
    entry: { command, unknownCause: "timeout" },
  });
  response.resolve(
    Response.json({ result: { data: superjson.serialize({ id, accountId: null }) } }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(owner.snapshot(id).state).toBe("saved");
  expect(owner.entries()).toEqual([]);
});
it("closes a request two minutes after the deadline and retries with the same key", async () => {
  vi.useFakeTimers();
  const storage = new FakePhone();
  let signal: AbortSignal | null | undefined;
  const bodies: (BodyInit | null | undefined)[] = [];
  const owner = new PhoneEntries({
    scope,
    storage,
    identity: () => scope,
    dispatch: requester((_input, init) => {
      bodies.push(init?.body);
      if (bodies.length === 2)
        return Promise.resolve(
          Response.json({ result: { data: superjson.serialize({ id, accountId: null }) } }),
        );
      signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }),
    now: () => now,
    reportError: vi.fn(),
  });
  await owner.restore();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(20000);
  const unknown = storage.saved().entries[id];
  expect(unknown).toMatchObject({
    command,
    attempt: 1,
    status: "unknown",
    unknownCause: "timeout",
  });
  await vi.advanceTimersByTimeAsync(119999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);
  expect(storage.saved().entries[id]).toEqual(unknown);
  expect(owner.snapshot(id)).toMatchObject({ state: "unknown", entry: unknown });
  await owner.retry(id, false);
  await vi.advanceTimersByTimeAsync(0);
  expect(bodies).toEqual([bodies[0], bodies[0]]);
  expect(owner.snapshot(id).state).toBe("saved");
  expect(storage.saved().entries).toEqual({});
});
it.each(["receipt", "401"] as const)(
  "ignores a %s that arrives after the request was closed",
  async (kind) => {
    vi.useFakeTimers();
    const storage = new FakePhone();
    const response = Promise.withResolvers<Response>();
    const sessionEnded = vi.fn();
    const owner = new PhoneEntries({
      scope,
      storage,
      identity: () => scope,
      dispatch: requester(() => response.promise, sessionEnded),
      now: () => now,
      reportError: vi.fn(),
      sessionEnded,
    });
    await owner.restore();
    await owner.save(command, draft, false);
    await vi.advanceTimersByTimeAsync(140000);
    const row = structuredClone(storage.saved());
    response.resolve(
      kind === "receipt"
        ? Response.json({ result: { data: superjson.serialize({ id, accountId: null }) } })
        : unauthorized(),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(storage.saved()).toEqual(row);
    expect(owner.snapshot(id).state).toBe("unknown");
    expect(sessionEnded).not.toHaveBeenCalled();
  },
);
it.each(["api", "proxy"] as const)(
  "records the %s 401 outcome before ending the session",
  async (source) => {
    const storage = new FakePhone();
    const response = Promise.withResolvers<Response>();
    const ended = vi.fn();
    const endSession = vi.fn(() => {
      expect(storage.saved().entries[id]?.status).toBe(source === "api" ? "notSaved" : "unknown");
      owner.retire();
    });
    const owner = new PhoneEntries({
      scope,
      storage,
      identity: () => scope,
      dispatch: requester(() => response.promise, ended),
      now: () => now,
      reportError: vi.fn(),
      sessionEnded: endSession,
    });
    await owner.restore();
    await owner.save(command, draft, false);
    response.resolve(
      source === "api" ? unauthorized() : new Response("Unauthorized", { status: 401 }),
    );
    await vi.waitFor(() => {
      expect(endSession).toHaveBeenCalledOnce();
    });
    expect(storage.saved().entries[id]?.status).toBe(source === "api" ? "notSaved" : "unknown");
    expect(ended).not.toHaveBeenCalled();
  },
);
it("keeps the current owner's row when a retired request answers after another sign-in", async () => {
  vi.useFakeTimers();
  const storage = new FakePhone();
  const response = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;
  let signedIn = scope;
  const makeOwner = (ownerScope: Scope, fetch: Fetch) =>
    new PhoneEntries({
      scope: ownerScope,
      identity: () => signedIn,
      storage,
      dispatch: requester(fetch),
      now: () => now,
      reportError: vi.fn(),
    });
  const original = makeOwner(scope, (_input, init) => {
    signal = init?.signal;
    return response.promise;
  });
  await original.restore();
  await original.save(command, draft, false);
  signedIn = { ...scope, person: "another-person" };
  original.retire();
  const other = makeOwner(signedIn, vi.fn());
  await other.restore();
  expect(other.entries()).toEqual([]);
  other.retire();
  signedIn = scope;
  const current = makeOwner(scope, vi.fn());
  await current.restore();
  const latestDraft = { ...draft, id: "another-lead", note: "Kept by the current owner" };
  await current.keepDraft(latestDraft, latestDraft.id, "attempt");
  const before = structuredClone(storage.saved());
  const writes = storage.writes;
  response.resolve(
    Response.json({ result: { data: superjson.serialize({ id, accountId: null }) } }),
  );
  await vi.advanceTimersByTimeAsync(0);
  await original.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
  expect(storage.saved()).toEqual(before);
  expect(storage.writes).toBe(writes);
  expect(current.snapshot(id)).toMatchObject({ state: "unknown", entry: { command, attempt: 1 } });
  expect(signal?.aborted).toBe(true);
});
const commands: readonly Command[] = [
  command,
  { operation: "note", payload: { id, key, note: "A note" } },
  { operation: "callback", payload: { id, key, change: { kind: "clear" } } },
  { operation: "close", payload: { id, key, closing: { kind: "won" } } },
];
it.each(commands)(
  "accepts the minimal receipt for $operation, including additive server fields",
  async (command) => {
    const dispatch = requester((_url, init) => {
      expect(init?.body).not.toContain('"attempt":');
      expect(init?.body).not.toContain("followsUnknown");
      return Promise.resolve(
        Response.json({
          result: { data: superjson.serialize({ id, accountId: null, addedInFuture: "ignored" }) },
        }),
      );
    });
    expect(await dispatch(command)).toEqual({
      kind: "receipt",
      receipt: { id, accountId: null },
    });
  },
);
it.each(["<html>proxy</html>", '{"result":{"data":{"json":{"id":"wrong"}}}}'])(
  "keeps a truly unreadable receipt unknown",
  async (body) => {
    expect(await requester(() => Promise.resolve(new Response(body)))(command)).toEqual({
      kind: "unknown",
      cause: "unreadable",
    });
  },
);
it.each([false, true])(
  "deletes the one phone store after token removal, local removal %s",
  async (local) => {
    const storage = new FakePhone();
    const owner = new PhoneEntries({
      reportError: vi.fn(),
      scope,
      storage,
      identity: () => scope,
      dispatch: requester(() => new Promise(() => undefined)),
      now: () => now,
    });
    await owner.restore();
    await owner.keepDraft({ ...draft, operation: "note" }, id, "note");
    await owner.save(command, draft, true);
    const order: string[] = [];
    await signOutFromPhone(
      {
        revoke: () => {
          order.push("server");
          return Promise.resolve();
        },
        remove: () => {
          order.push("token");
          return Promise.resolve(true);
        },
        erase: () => {
          order.push("phone");
          return erasePhone(owner, storage, scope);
        },
        forget: () => {
          order.push("memory");
        },
      },
      local,
    );
    expect(order).toEqual(
      local ? ["token", "phone", "memory"] : ["server", "token", "phone", "memory"],
    );
    const restored = new PhoneEntries({
      reportError: vi.fn(),
      scope,
      storage,
      identity: () => scope,
      dispatch: requester(() => new Promise(() => undefined)),
      now: () => now,
    });
    await restored.restore();
    expect(restored.counts()).toEqual({ entries: 0, drafts: 0 });
  },
);

it("a real late transport receipt during retry storage settles saved without another dispatch", async () => {
  vi.useFakeTimers();
  const storage = new FakePhone();
  const response = Promise.withResolvers<Response>();
  const fetch = vi.fn(() => response.promise);
  const owner = new PhoneEntries({
    scope,
    storage,
    identity: () => scope,
    dispatch: requester(fetch),
    now: () => now,
    reportError: vi.fn(),
  });
  await owner.restore();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(20001);
  const gate = Promise.withResolvers<undefined>();
  storage.gate = gate.promise;
  const retry = owner.retry(id, false);
  await flush();
  response.resolve(
    Response.json({ result: { data: superjson.serialize({ id, accountId: null }) } }),
  );
  await flush();
  expect(owner.snapshot(id).state).toBe("storing");
  gate.resolve(undefined);
  await retry;
  expect(owner.snapshot(id).state).toBe("saved");
  expect(fetch).toHaveBeenCalledTimes(1);
});
