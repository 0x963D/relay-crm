import { expect, it } from "vitest";
import { backgroundWrite, dismissWrite } from "../src/core/write-dismissal.ts";
import type { WriteState } from "../src/core/write-machine.ts";

const expected: readonly [WriteState, string, string, string][] = [
  ["editing", "close", "discardDraft", "keepDraft"],
  ["storageFailed", "discardDraft", "discardDraft", "keepDraft"],
  ["storing", "blocked", "blocked", "continue"],
  ["sendingFirst", "blocked", "blocked", "continue"],
  ["sendingRetry", "blocked", "blocked", "continue"],
  ["neverSubmitted", "close", "close", "keep"],
  ["unknown", "close", "close", "keep"],
  ["notSaved", "close", "close", "keep"],
  ["refused", "close", "close", "keep"],
  ["refusedAfterUnknown", "close", "close", "keep"],
  ["saved", "close", "close", "keep"],
];
it.each(expected)(
  "dismisses %s consistently for close, swipe and Back",
  (state, empty, content, background) => {
    expect(dismissWrite(state, false, false)).toBe(empty);
    expect(dismissWrite(state, true, false)).toBe(content);
    expect(backgroundWrite(state)).toBe(background);
  },
);
it("withdraws an interrupted confirmation without discarding the draft", () => {
  expect(dismissWrite("editing", true, true)).toBe("withdrawConfirmation");
  expect(backgroundWrite("editing")).toBe("keepDraft");
});
