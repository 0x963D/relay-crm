import { expect, it } from "vitest";
import { LeadId } from "@relay/domain";
import { queueFocus } from "../src/core/queue-focus.ts";
import { at, queue, row } from "./fixtures.ts";
const other = LeadId.parse("10000000-0000-4000-8000-000000000002");
if (!other) throw new Error("Invalid fixture");
const neighbor = { ...row, id: other };
it("follows a row into another open group and announces its move", () => {
  expect(
    queueFocus(
      queue(),
      queue({ notYetCalled: [], dueToday: [{ ...row, callbackAt: at }] }),
      row.id,
      new Set(),
    ),
  ).toEqual({ target: `row:${row.id}`, announcement: "Hye-jin Park moved to Due today" });
});
it("focuses a folded destination's header", () => {
  expect(
    queueFocus(queue(), queue({ notYetCalled: [], later: [row] }), row.id, new Set(["later"]))
      ?.target,
  ).toBe("group:later");
});
it("focuses the next row when the focused row leaves", () => {
  expect(
    queueFocus(
      queue({ notYetCalled: [row, neighbor] }),
      queue({ notYetCalled: [neighbor] }),
      row.id,
      new Set(),
    )?.target,
  ).toBe(`row:${other}`);
});
it("uses the previous row when there is no next one", () => {
  expect(
    queueFocus(
      queue({ notYetCalled: [neighbor, row] }),
      queue({ notYetCalled: [neighbor] }),
      row.id,
      new Set(),
    )?.target,
  ).toBe(`row:${other}`);
});
it("uses the group's header when it has no remaining row", () => {
  expect(
    queueFocus(
      queue(),
      queue({
        notYetCalled: [],
        later: [neighbor],
        counts: { ...queue().counts, notYetCalled: 0, later: 1 },
      }),
      row.id,
      new Set(),
    )?.target,
  ).toBe("group:notYetCalled");
});
it("uses the empty state's title when the whole queue empties", () => {
  expect(
    queueFocus(
      queue(),
      queue({
        notYetCalled: [],
        counts: { overdueCallbacks: 0, dueToday: 0, noCallbackSet: 0, notYetCalled: 0, later: 0 },
      }),
      row.id,
      new Set(),
    ),
  ).toEqual({ target: "state", announcement: "Hye-jin Park left your queue" });
});
it("does not move focus when the focused row stays in place", () => {
  expect(queueFocus(queue(), queue(), row.id, new Set())).toBeNull();
});
