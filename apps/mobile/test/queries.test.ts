import { expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import superjson from "superjson";
import { createClient } from "../src/api/client.ts";
import { queryDefaults, queryReads } from "../src/api/queries.ts";

vi.mock("../src/api/token.ts", () => ({ bearer: () => null }));
it("isolates reads by server and person, and shares one read in the same scope", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(Response.json({ result: { data: superjson.serialize({ demo: false }) } })),
    );
  const api = createClient({
    origin: "https://one.example",
    fetch,
    token: () => null,
    sessionEnded: vi.fn(),
  });
  const cache = new QueryClient({ defaultOptions: queryDefaults });
  const one = queryReads("https://one.example", "one", api.rpc).info;
  await Promise.all([cache.query(one), cache.query(one)]);
  expect(fetch).toHaveBeenCalledTimes(1);
  await cache.query(queryReads("https://one.example", "two", api.rpc).info);
  await cache.query(queryReads("https://two.example", "one", api.rpc).info);
  expect(fetch).toHaveBeenCalledTimes(3);
  cache.clear();
});
it("aborts the transport when a query is cancelled", async () => {
  let signal: AbortSignal | null | undefined;
  let dispatched: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const api = createClient({
    origin: "https://one.example",
    token: () => "one",
    sessionEnded: vi.fn(),
    fetch: (_input, init) => {
      signal = init?.signal;
      dispatched?.();
      return new Promise(() => undefined);
    },
  });
  const cache = new QueryClient({ defaultOptions: queryDefaults });
  const options = queryReads("https://one.example", "one", api.rpc).queue;
  const pending = cache.query(options).catch(() => undefined);
  await started;
  await cache.cancelQueries({ queryKey: options.queryKey });
  await pending;
  expect(signal?.aborted).toBe(true);
  cache.clear();
});
it("does not retry a mutation outside its stored-entry owner", async () => {
  const cache = new QueryClient({ defaultOptions: queryDefaults });
  const write = vi.fn().mockRejectedValue(new Error("no answer"));
  const mutation = cache.getMutationCache().build(cache, { mutationFn: write });
  await expect(mutation.execute(undefined)).rejects.toThrow("no answer");
  expect(write).toHaveBeenCalledTimes(1);
  cache.clear();
});
it("keeps a paused owner's cache in place without enabling private reads", () => {
  const active = queryReads("https://one.example", "one");
  const paused = queryReads("https://one.example", "one", undefined, false);
  expect(paused.queue.queryKey).toEqual(active.queue.queryKey);
  expect(paused.profile.queryKey).toEqual(active.profile.queryKey);
  expect(paused.lead("lead").queryKey).toEqual(active.lead("lead").queryKey);
  expect(paused.queue.enabled).toBe(false);
  expect(paused.profile.enabled).toBe(false);
  expect(paused.lead("lead").enabled).toBe(false);
});
