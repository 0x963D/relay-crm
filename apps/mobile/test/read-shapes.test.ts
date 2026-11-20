import { expect, it, vi } from "vitest";
import superjson from "superjson";
import { createClient } from "../src/api/client.ts";
import { queueReadShape, leadReadShape } from "../src/core/read-shapes.ts";
import { attemptOutcome, rowPresentation } from "../src/core/queue.ts";
import { knownLeadState } from "../src/core/lead.ts";
import { queue, row, at } from "./fixtures.ts";

vi.mock("../src/api/token.ts", () => ({ bearer: () => null }));
it.each([
  { status: "futureStatus" },
  {
    status: "working",
    assignee: { ownerId: "person", teamId: "team" },
    stage: { kind: "futureStage" },
  },
  { status: "dead", assignee: null, reason: "futureReason" },
])("accepts an unknown lifecycle value $status without discarding the queue", (state) => {
  expect(
    queueReadShape.safeParse({
      ...queue(),
      notYetCalled: [{ ...row, lifecycle: { ...row.lifecycle, state } }],
    }),
  ).toHaveProperty("success", true);
});
it("accepts unknown summary kinds, channels, outcomes and additive fields on a real client read", async () => {
  const data = queue({ noCallbackSet: [], notYetCalled: [] });
  const future = {
    ...data,
    noCallbackSet: [
      { ...row, lastNoteOrOutcome: { kind: "futureSummary" } },
      {
        ...row,
        lastNoteOrOutcome: {
          kind: "attempt",
          note: "A note",
          outcome: "futureOutcome",
          channel: "futureChannel",
          callbackAt: null,
          noAnswerCount: null,
        },
      },
    ],
    futureField: true,
  };
  const client = createClient({
    origin: "https://relay.example",
    token: () => "token",
    sessionEnded: vi.fn(),
    fetch: () => Promise.resolve(Response.json({ result: { data: superjson.serialize(future) } })),
  });
  const result = await client.rpc.leads.queue.query({ limit: 100 });
  const first = result.noCallbackSet[0];
  if (!first) throw new Error("Expected a queue row.");
  expect(rowPresentation(first, "noCallbackSet", at, "UTC").slips[0]?.text).toBe("Attempt logged");
  expect(attemptOutcome("futureOutcome", 4).text).toBe("Attempt logged");
  expect(knownLeadState("futureStatus")).toBe(false);
});
it("still rejects missing fields used by a known screen", () => {
  expect(queueReadShape.safeParse({ ...queue(), timeZone: "not/a/zone" })).toHaveProperty(
    "success",
    false,
  );
  expect(leadReadShape.safeParse({ id: row.id })).toHaveProperty("success", false);
});
