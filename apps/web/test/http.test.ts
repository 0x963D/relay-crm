import { describe, expect, it } from "vitest";
import { readBody } from "../src/server/http.ts";

describe("bounded bodies", () => {
  it.each([100_000, 100_001])("enforces the byte limit at %s bytes", async (size) => {
    const body = await readBody(
      new Request("http://relay.example", { method: "POST", body: "x".repeat(size) }),
    );
    expect(body?.byteLength ?? null).toBe(size === 100_000 ? size : null);
  });
  it("stops a chunked body without trusting a smaller content length", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(30_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const init = {
      method: "POST",
      headers: { "content-length": "1" },
      body: stream,
      duplex: "half",
    };
    const request = new Request("http://relay.example", init);
    expect(await readBody(request)).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(5);
  });
  it("refuses an oversized declared length without reading the stream", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const init = {
      method: "POST",
      headers: { "content-length": "2000000" },
      body: stream,
      duplex: "half",
    };
    const request = new Request("http://relay.example", init);
    expect(await readBody(request)).toBeNull();
    expect(cancelled).toBe(true);
  });
});
