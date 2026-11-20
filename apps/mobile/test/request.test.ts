import { afterEach, describe, expect, it, vi } from "vitest";
import { Response as ReactNativeResponse } from "whatwg-fetch";
import { createRequester } from "../src/core/request.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("native request boundary", () => {
  it("keeps letters outside ASCII intact with React Native's Response", async () => {
    const sent = { campaign: "IELTS evening · January intake", name: "Zoë Łukasiewicz" };
    // The platform's response reads text as UTF-8 and hands bytes over untouched, as this one does.
    const platform = Response.json(sent);
    // React Native installs this Response, and the requester builds its answer with it.
    vi.stubGlobal("Response", ReactNativeResponse);
    const request = createRequester({ fetch: () => Promise.resolve(platform), token: () => null });
    const response = await request("https://relay.example/api/trpc/work.queue");
    expect(await response.json()).toEqual(sent);
  });
  it("sends the owner's bearer token and removes browser credentials", async () => {
    const fetch = vi
      .fn<Parameters<typeof createRequester>[0]["fetch"]>()
      .mockResolvedValue(Response.json({ ok: true }));
    const request = createRequester({ fetch, token: () => "opaque", sessionEnded: vi.fn() });
    const response = await request("https://relay.example/api/trpc/session.current", {
      headers: {
        Origin: "https://wrong.example",
        Cookie: "session=browser",
        Authorization: "Bearer stale",
      },
      credentials: "include",
    });
    const init = fetch.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer opaque");
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("cookie")).toBe(false);
    expect(init?.credentials).toBe("omit");
    expect(await response.json()).toEqual({ ok: true });
  });
  it("adds no token to a public read", async () => {
    const fetch = vi
      .fn<Parameters<typeof createRequester>[0]["fetch"]>()
      .mockResolvedValue(Response.json({ demo: false }));
    await createRequester({ fetch, token: () => null, sessionEnded: vi.fn() })(
      "https://relay.example/api/trpc/server.info",
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  });
  it("ends a session on 401 but not on an outage", async () => {
    const ended = vi.fn();
    const fetch = vi
      .fn<Parameters<typeof createRequester>[0]["fetch"]>()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const request = createRequester({ fetch, token: () => "a", sessionEnded: ended });
    await request("https://relay.example");
    await request("https://relay.example");
    expect(ended).toHaveBeenCalledTimes(1);
  });
  it("does not end a new session when an old request returns 401", async () => {
    let token = "a";
    const ended = vi.fn();
    const fetch = vi.fn<Parameters<typeof createRequester>[0]["fetch"]>().mockImplementation(() => {
      token = "b";
      return Promise.resolve(new Response("", { status: 401 }));
    });
    await createRequester({ fetch, token: () => token, sessionEnded: ended })(
      "https://relay.example",
    );
    expect(ended).not.toHaveBeenCalled();
  });
  it("maps a dropped connection to network failure", async () => {
    const fetch = vi
      .fn<Parameters<typeof createRequester>[0]["fetch"]>()
      .mockRejectedValue(new TypeError("network"));
    await expect(
      createRequester({ fetch, token: () => null, sessionEnded: vi.fn() })("https://relay.example"),
    ).rejects.toMatchObject({ failure: { kind: "network" } });
  });
  it("preserves the received status when the response body times out", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<Parameters<typeof createRequester>[0]["fetch"]>()
      .mockImplementation((_url, init) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener("abort", () => {
                  controller.error(new Error("aborted"));
                });
              },
            }),
          ),
        ),
      );
    const request = createRequester({ fetch, token: () => null, sessionEnded: vi.fn() });
    const result = expect(request("https://relay.example")).rejects.toMatchObject({
      failure: { kind: "unreadable", status: 200 },
    });
    await vi.advanceTimersByTimeAsync(20000);
    await result;
  });
});
