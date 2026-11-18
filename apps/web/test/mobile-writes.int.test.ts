import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { test } from "@relay/store/testing";
import type { TestDatabase } from "@relay/store/testing";
import { createAuthentication } from "../src/server/auth.ts";
import { connections } from "../src/server/client-address.ts";
import { handleRpc } from "../src/server/rpc.ts";
import { createClient } from "../../mobile/src/api/client.ts";
import { writeRequest } from "../../mobile/src/api/write-request.ts";
import { PhoneEntries } from "../../mobile/src/core/phone-entries.ts";
import type { PhoneStorage } from "../../mobile/src/core/phone-entries.ts";
import type { PhoneData } from "../../mobile/src/core/write-model.ts";
import { initialDraft, formCommand } from "../../mobile/src/core/write-form.ts";
import { writeBand } from "../../mobile/src/core/write-presentation.ts";

vi.mock("../../mobile/src/api/token.ts", () => ({ bearer: () => null }));
const origin = "http://localhost:3405";
const latch = (): PromiseWithResolvers<void> => Promise.withResolvers();
async function setup(db: TestDatabase) {
  const person = await db.seedUser("agent");
  const team = await db.seedTeam("sales");
  await db.ownerRows("INSERT INTO memberships(user_id,team_id) VALUES ($1,$2)", [person, team]);
  const lead = await db.seedLead({
    email: "mobile-write@example.com",
    lifecycle: {
      state: { status: "assigned", assignee: { ownerId: person, teamId: team } },
      firstAssignedAt: new Date(),
      previousOwnerId: null,
    },
  });
  const codes: string[] = [];
  const tasks: (() => Promise<void>)[] = [];
  const auth = createAuthentication(
    db.store,
    {
      baseUrl: origin,
      secret: "mobile-write-integration-secret-at-least-thirty-two-characters",
      trustedProxyCount: 0,
      globalLimit: 10000,
      delivery: { kind: "developmentConsole" },
    },
    (message) => {
      codes.push(message.code);
      return Promise.resolve();
    },
    (task) => {
      tasks.push(task);
    },
  );
  let token: string | null = null;
  let dropNext = false;
  let dropped = latch();
  let together: PromiseWithResolvers<void> | null = null;
  let arrivals = 0;
  const nativeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const work = async () => {
      if (together && request.url.includes("leads.logAttempt")) {
        const gate = together;
        arrivals += 1;
        if (arrivals === 2) {
          together = null;
          gate.resolve();
        }
        await gate.promise;
      }
      if (request.url.includes("/api/auth/")) {
        const response = await connections.run("127.0.0.1", () => auth.handle(request));
        for (const task of tasks.splice(0)) await task();
        return response;
      }
      const response = await handleRpc(
        request,
        async () => ({ store: db.store, principal: await auth.principal(request.headers) }),
        origin,
      );
      if (dropNext && request.url.includes("leads.logAttempt")) {
        dropNext = false;
        expect(response.status, await response.clone().text()).toBe(200);
        dropped.resolve();
        throw new TypeError("The response was lost after commit.");
      }
      return response;
    };
    let onAbort = () => undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => {
            reject(new DOMException("The request was aborted.", "AbortError"));
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.signal.aborted) onAbort();
        }),
      ]);
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  };
  const client = createClient({
    origin,
    fetch: nativeFetch,
    token: () => token,
    sessionEnded: vi.fn(),
  });
  await client.auth.sendCode("user-1@team.example");
  const credential = await client.auth.signIn("user-1@team.example", codes.at(-1) ?? "");
  token = credential.token;
  expect(credential.user.id).toBe(person);
  let stored: PhoneData | null = null;
  const storage: PhoneStorage = {
    load: () => Promise.resolve(structuredClone(stored)),
    replace: (_scope, data) => {
      stored = structuredClone(data);
      return Promise.resolve();
    },
    remove: () => {
      stored = null;
      return Promise.resolve();
    },
  };
  const scope = { server: origin, person };
  const owner = new PhoneEntries({
    reportError: vi.fn(),
    scope,
    storage,
    identity: () => scope,
    dispatch: writeRequest(client.rpc),
    now: () => new Date(),
    requestTimeoutMs: 20000,
  });
  await owner.restore();
  const draft = {
    ...initialDraft({
      id: lead,
      name: "Mobile lead",
      operation: "attempt",
      callback: null,
      now: new Date(),
    }),
    note: "Reached the native write proof",
  };
  const command = formCommand(draft, randomUUID(), new Date());
  if ("field" in command) throw new Error(command.text);
  return {
    owner,
    client,
    lead,
    person,
    draft,
    command,
    scope,
    storage,
    dispatch: writeRequest(client.rpc),
    nativeFetch,
    concurrent: () => {
      together = latch();
      arrivals = 0;
    },
    arrivals: () => arrivals,
    drop: () => {
      dropped = latch();
      dropNext = true;
      return dropped.promise;
    },
  };
}
test("a dropped native attempt answer retries the stored key and writes exactly one timeline entry", async ({
  db,
}) => {
  const { owner, lead, command, draft, drop } = await setup(db);
  const committed = drop();
  await owner.save(command, draft, false);
  await committed;
  await vi.waitFor(() => {
    expect(owner.snapshot(lead).state).toBe("unknown");
  });
  const key = owner.snapshot(lead).entry?.command.payload.key;
  await owner.retry(lead, false);
  await vi.waitFor(() => {
    expect(owner.snapshot(lead).state).toBe("saved");
  });
  expect(key).toBe(command.payload.key);
  expect(owner.entries()).toHaveLength(0);
  expect(
    await db.rows(
      "SELECT count(*)::int AS count FROM activities WHERE lead_id=$1 AND kind='attempt'",
      [lead],
    ),
  ).toEqual([{ count: 1 }]);
});
test("a committed attempt followed by lost access is refused after unknown without denying the first save", async ({
  db,
}) => {
  const { owner, lead, command, draft, drop } = await setup(db);
  const committed = drop();
  await owner.save(command, draft, false);
  await committed;
  await vi.waitFor(() => {
    expect(owner.snapshot(lead).state).toBe("unknown");
  });
  const other = await db.seedUser("agent");
  await db.ownerRows(
    "INSERT INTO memberships(user_id,team_id) SELECT $1,team_id FROM leads WHERE id=$2",
    [other, lead],
  );
  await db.ownerRows("UPDATE leads SET owner_id=$1 WHERE id=$2", [other, lead]);
  await owner.retry(lead, false);
  await vi.waitFor(() => {
    expect(owner.snapshot(lead).state).toBe("refusedAfterUnknown");
  });
  const words = writeBand(owner.snapshot(lead), true);
  expect(words?.title).toBe("Refused on retry. This lead is no longer yours.");
  expect(words?.text).toContain("The first try may have saved");
  expect(words?.title.toLowerCase()).not.toContain("not saved");
  expect(
    await db.rows(
      "SELECT count(*)::int AS count FROM activities WHERE lead_id=$1 AND kind='attempt'",
      [lead],
    ),
  ).toEqual([{ count: 1 }]);
});
test("an attempt without a callback removes the lead's existing callback", async ({ db }) => {
  const { owner, client, lead, command, draft } = await setup(db);
  const states: string[] = [];
  owner.subscribe(() => {
    states.push(owner.snapshot(lead).state);
  });
  await client.rpc.leads.setCallback.mutate({
    id: lead,
    key: randomUUID(),
    change: { kind: "set", at: new Date(Date.now() + 3600000) },
  });
  expect(
    await db.rows("SELECT call_back_at IS NOT NULL AS present FROM leads WHERE id=$1", [lead]),
  ).toEqual([{ present: true }]);
  await owner.save(command, draft, false);
  await vi.waitFor(() => {
    expect(owner.snapshot(lead).state).toBe("saved");
  });
  expect(states).not.toContain("unknown");
  expect(await db.rows("SELECT call_back_at,stage FROM leads WHERE id=$1", [lead])).toEqual([
    { call_back_at: null, stage: "noAnswer" },
  ]);
});

test("two in-flight requests for the same key save one activity and return identical receipts", async ({
  db,
}) => {
  const { dispatch, command, lead, concurrent, arrivals } = await setup(db);
  concurrent();
  const [first, second] = await Promise.all([dispatch(command), dispatch(command)]);
  expect(arrivals()).toBe(2);
  expect(first).toMatchObject({ kind: "receipt", receipt: { id: lead } });
  expect(second).toEqual(first);
  expect(
    await db.rows(
      "SELECT count(*)::int AS count FROM activities WHERE lead_id=$1 AND kind='attempt'",
      [lead],
    ),
  ).toEqual([{ count: 1 }]);
});
for (const phase of ["already", "in flight"]) {
  test(`the integration transport rejects an aborted request ${phase}`, async ({ db }) => {
    const { nativeFetch } = await setup(db);
    const controller = new AbortController();
    if (phase === "already") controller.abort();
    const request = nativeFetch(`${origin}/api/auth/get-session`, { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toThrow();
  });
}
