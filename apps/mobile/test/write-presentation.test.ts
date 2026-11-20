import { expect, it } from "vitest";
import { entriesFact, storedCounts } from "../src/core/write-presentation.ts";
it("names an unknown number of kept items when the store has not loaded", () => {
  expect(storedCounts(null)).toBe("An unknown number of kept items");
});
it.each(["storageFailed", "sendingFirst", "storing", "unknown"] as const)(
  "never calls a %s entry saved in the queue",
  (state) => {
    expect(entriesFact([state])).toBe("It may not have saved.");
    expect(entriesFact(["saved", state])).toBe("Some may not have saved.");
  },
);
it("only promises a save when every kept entry is known saved", () => {
  expect(entriesFact(["saved", "saved"])).toBe("It was saved.");
  expect(entriesFact([undefined])).toBe("It may not have saved.");
});
