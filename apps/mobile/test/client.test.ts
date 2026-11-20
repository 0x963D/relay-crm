import { afterEach, expect, it, vi } from "vitest";
import superjson from "superjson";
import { createClient, read } from "../src/api/client.ts";
import type { Fetch } from "../src/core/request.ts";
import { queue, row } from "./fixtures.ts";

vi.mock("../src/api/token.ts", () => ({ bearer: () => null }));
afterEach(() => vi.useRealTimers());
function client(fetch: Fetch, token: () => string | null = () => "one", ended = vi.fn()) {
  return {
    ...createClient({ origin: "https://relay.example", fetch, token, sessionEnded: ended }),
    ended,
  };
}
it.each([
  [502, "<html>proxy</html>", "http"],
  [503, "unavailable", "http"],
  [200, "<html>login</html>", "unreadable"],
  [200, '{"wrong":true}', "unreadable"],
  [200, '{"result":{"data":{"json":{"wrong":true}}}}', "unreadable"],
  [401, "expired", "http"],
] as const)("keeps status %i for %s", async (status, body, kind) => {
  const api = client(() => Promise.resolve(new Response(body, { status })));
  await expect(read(() => api.rpc.server.info.query())).rejects.toMatchObject({
    failure: { kind, status },
  });
  expect(api.ended).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
it("classifies an unusable sign-in answer as unreadable", async () => {
  const api = client(() => Promise.resolve(Response.json({ success: true })));
  await expect(api.auth.signIn("agent@example.com", "123456")).rejects.toMatchObject({
    failure: { kind: "unreadable", status: 200 },
  });
});
it("preserves a typed refusal and its status", async () => {
  const api = client(() =>
    Promise.resolve(
      Response.json(
        {
          error: {
            json: {
              message: "denied",
              code: -32003,
              data: { code: "FORBIDDEN", httpStatus: 403, accessFailure: "accessDenied" },
            },
          },
        },
        { status: 403 },
      ),
    ),
  );
  await expect(read(() => api.rpc.leads.get.query({ id: "lead" }))).rejects.toMatchObject({
    failure: { kind: "refused", status: 403, reason: "accessDenied" },
  });
});
it.each([
  [400, "refused"],
  [503, "http"],
] as const)("reads the API's %i error using the answer table", async (status, kind) => {
  const api = client(() =>
    Promise.resolve(
      Response.json(
        {
          error: {
            json: {
              message: "rejected",
              code: -32600,
              data: {
                code: status === 400 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR",
                httpStatus: status,
              },
            },
          },
        },
        { status },
      ),
    ),
  );
  await expect(read(() => api.rpc.server.info.query())).rejects.toMatchObject({
    failure: { kind, status },
  });
});
it("reads a valid answer through the real tRPC link", async () => {
  const api = client(() =>
    Promise.resolve(Response.json({ result: { data: superjson.serialize({ demo: false }) } })),
  );
  await expect(read(() => api.rpc.server.info.query())).resolves.toMatchObject({ demo: false });
});
it("restores dates and bigints before accepting a queue answer", async () => {
  const api = client(() =>
    Promise.resolve(Response.json({ result: { data: superjson.serialize(queue()) } })),
  );
  await expect(read(() => api.rpc.leads.queue.query({ limit: 100 }))).resolves.toEqual(queue());
});
it("rejects a queue body whose date and bigint metadata is missing", async () => {
  const api = client(() =>
    Promise.resolve(
      Response.json({ result: { data: { json: superjson.serialize(queue()).json } } }),
    ),
  );
  await expect(read(() => api.rpc.leads.queue.query({ limit: 100 }))).rejects.toMatchObject({
    failure: { kind: "unreadable", status: 200 },
  });
});
it("does not accept a success-shaped 5xx as a receipt", async () => {
  const api = client(() =>
    Promise.resolve(
      Response.json({ result: { data: superjson.serialize({ demo: false }) } }, { status: 503 }),
    ),
  );
  await expect(read(() => api.rpc.server.info.query())).rejects.toMatchObject({
    failure: { kind: "http", status: 503 },
  });
});
it("requires a decoded response schema before accepting another operation", async () => {
  const api = client(() =>
    Promise.resolve(Response.json({ result: { data: superjson.serialize({ ok: true }) } })),
  );
  await expect(
    read(() => api.rpc.payments.get.query({ id: "not-registered" })),
  ).rejects.toMatchObject({ failure: { kind: "unreadable", status: 200 } });
});
it("accepts a usable lead and rejects a working lead with no stage", async () => {
  const lead = {
    ...row,
    contactedAt: null,
    lostNote: null,
    custody: { assignedBy: null, heldBy: null },
    attribution: null,
    timeline: [],
  };
  let value: unknown = lead;
  const api = client(() =>
    Promise.resolve(Response.json({ result: { data: superjson.serialize(value) } })),
  );
  await expect(read(() => api.rpc.leads.get.query({ id: row.id }))).resolves.toMatchObject({
    id: row.id,
  });
  value = { ...lead, lifecycle: { ...lead.lifecycle, state: { status: "working" } } };
  await expect(read(() => api.rpc.leads.get.query({ id: row.id }))).rejects.toMatchObject({
    failure: { kind: "unreadable", status: 200 },
  });
});
it("keeps the API's typed unauthorized answer separate from a proxy's plain 401", async () => {
  const api = client(() =>
    Promise.resolve(
      Response.json(
        {
          error: {
            json: {
              message: "session ended",
              code: -32001,
              data: { code: "UNAUTHORIZED", httpStatus: 401 },
            },
          },
        },
        { status: 401 },
      ),
    ),
  );
  await expect(read(() => api.rpc.server.info.query())).rejects.toMatchObject({
    failure: { kind: "sessionEnded", status: 401 },
  });
  expect(api.ended).toHaveBeenCalledOnce();
});
it("does not end the current session for an old token's 401", async () => {
  let token = "one";
  const ended = vi.fn();
  const api = client(
    () => {
      token = "two";
      return Promise.resolve(new Response("old", { status: 401 }));
    },
    () => token,
    ended,
  );
  await expect(read(() => api.rpc.server.info.query())).rejects.toMatchObject({
    failure: { kind: "http", status: 401 },
  });
  expect(ended).not.toHaveBeenCalled();
});
it("does not invent an ended session for a public request without a token", async () => {
  const ended = vi.fn();
  const api = client(
    () => Promise.resolve(new Response("proxy", { status: 401 })),
    () => null,
    ended,
  );
  await expect(read(() => api.rpc.server.info.query())).rejects.toMatchObject({
    failure: { kind: "http", status: 401 },
  });
  expect(ended).not.toHaveBeenCalled();
});
it("classifies failure before an answer as network", async () => {
  const api = client(() => Promise.reject(new TypeError("connection")));
  await expect(read(() => api.rpc.server.info.query())).rejects.toMatchObject({
    failure: { kind: "network" },
  });
});
it.each([200, 401])("accepts sign-out confirmation at %i", async (status) => {
  const api = client(() =>
    Promise.resolve(
      status === 200 ? Response.json({ success: true }) : new Response("expired", { status }),
    ),
  );
  await expect(api.auth.signOut()).resolves.toBeUndefined();
});
it("does not confirm sign-out from an unreadable success body", async () => {
  const api = client(() => Promise.resolve(new Response("proxy")));
  await expect(api.auth.signOut()).rejects.toMatchObject({
    failure: { kind: "unreadable", status: 200 },
  });
});
it("ignores an old verification answer after a different token is installed", async () => {
  let token = "one";
  const ended = vi.fn();
  const api = client(
    () => {
      token = "two";
      return Promise.resolve(Response.json(null));
    },
    () => token,
    ended,
  );
  await expect(api.auth.verify()).rejects.toMatchObject({
    failure: { kind: "sessionEnded", status: 200 },
  });
  expect(ended).not.toHaveBeenCalled();
});
it("times out without claiming to cancel the server's request", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const api = client((_input, init) => {
    signal = init?.signal;
    return new Promise(() => undefined);
  });
  const result = expect(read(() => api.rpc.server.info.query())).rejects.toMatchObject({
    failure: { kind: "noAnswer" },
  });
  await vi.advanceTimersByTimeAsync(20000);
  await result;
  expect(signal?.aborted).toBe(true);
});
