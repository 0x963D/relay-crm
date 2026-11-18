import { afterEach, expect, it, vi } from "vitest";
import superjson from "superjson";
import { createClient } from "../src/api/client.ts";
import { writeRequest } from "../src/api/write-request.ts";
import { PhoneEntries } from "../src/core/phone-entries.ts";
import { signOutFromPhone } from "../src/core/sign-out.ts";
import type { Command } from "../src/core/write-model.ts";
import type { Fetch } from "../src/core/request.ts";
import { command, draft, FakePhone, flush, id, key, now, scope } from "./write-fixtures.ts";

vi.mock("../src/api/token.ts", () => ({ bearer: () => null }));
afterEach(() => vi.useRealTimers());
function requester(fetch: Fetch) {
  return writeRequest(
    createClient({ origin: scope.server, fetch, token: () => "token", sessionEnded: vi.fn() }).rpc,
  );
}
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
  await vi.advanceTimersByTimeAsync(20001);
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
        erase: async () => {
          order.push("phone");
          await owner.removeAll();
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
