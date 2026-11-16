import { test, expect } from "vitest";
import { readVisibleRows } from "../src/lib/trpc/read-visible-rows.ts";
test("a visible list can cross the API page boundary without dropping rows", async () => {
  const requests: { limit: number; offset: number }[] = [];
  const result = await readVisibleRows(
    {
      limit: 125,
      read: (page) => {
        requests.push(page);
        return Promise.resolve(Array.from({ length: page.limit }, (_, i) => page.offset + i));
      },
      merge: (a, b) => [...a, ...b],
    },
    new AbortController().signal,
  );
  expect(requests).toEqual([
    { limit: 100, offset: 0 },
    { limit: 25, offset: 100 },
  ]);
  expect(result).toEqual(Array.from({ length: 125 }, (_, i) => i));
});
