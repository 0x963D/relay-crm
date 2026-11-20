import { describe, expect, it, vi } from "vitest";
import { clientAddress, connections } from "../src/server/client-address.ts";

function address(forwarded: string, count: number, peer = "::ffff:127.0.0.1") {
  return connections.run(peer, () =>
    clientAddress(
      new Request("http://relay.example", {
        headers: { "x-forwarded-for": forwarded, "x-real-ip": "192.0.2.99" },
      }),
      count,
    ),
  );
}

describe("client addresses", () => {
  it("uses the socket peer and ignores supplied headers without trusted proxies", () => {
    expect(address("192.0.2.1", 0)).toBe("127.0.0.1");
  });
  it("counts trusted hops from the right and ignores an attacker-controlled prefix", () => {
    expect(address("192.0.2.99, 192.0.2.1, 192.0.2.2", 2)).toBe("192.0.2.1");
  });
  it("falls back to the connection for malformed or incomplete chains", () => {
    expect(address("192.0.2.1", 2)).toBe("127.0.0.1");
    expect(address("not-an-ip", 1)).toBe("127.0.0.1");
  });
  it("canonicalizes equivalent IPv6 client addresses", () => {
    expect(address("2001:db8:0:0:0:0:0:1", 1)).toBe(address("2001:db8::1", 1));
  });
  it("writes a mapped IPv4 address as IPv4 in either spelling", () => {
    expect(address("::ffff:192.0.2.1", 1)).toBe("192.0.2.1");
    expect(address("::ffff:c000:201", 1)).toBe("192.0.2.1");
    expect(address("0:0:0:0:0:ffff:c000:0201", 1)).toBe("192.0.2.1");
  });
});

it("refuses an unknown client with a fixed error and logs the configuration once", async () => {
  const { protectHttp } = await import("../src/server/errors.ts");
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    for (let i = 0; i < 2; i += 1) {
      const response = await connections.run("", () =>
        protectHttp("request.failed", () =>
          Response.json({ address: clientAddress(new Request("http://relay.example"), 0) }),
        ),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ message: "Something went wrong." });
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(" ")).toContain("clientAddressUnavailable");
  } finally {
    log.mockRestore();
  }
});

describe("a hosted request with one trusted proxy and no socket peer", () => {
  const forwarded = (value?: string) =>
    new Request("https://relay.example", {
      headers: { "x-real-ip": "192.0.2.99", ...(value ? { "x-forwarded-for": value } : {}) },
    });

  it("uses a single IPv4 or IPv6 address and canonicalizes mapped IPv4", () => {
    expect(clientAddress(forwarded("192.0.2.1"), 1)).toBe("192.0.2.1");
    expect(clientAddress(forwarded("2001:db8:0:0:0:0:0:1"), 1)).toBe("[2001:db8::1]");
    expect(clientAddress(forwarded("::ffff:192.0.2.1"), 1)).toBe("192.0.2.1");
  });

  it("selects the verified hop even when the supplied prefix changes", () => {
    expect(clientAddress(forwarded("203.0.113.4, 192.0.2.1"), 1)).toBe("192.0.2.1");
    expect(clientAddress(forwarded("invalid, 192.0.2.1"), 1)).toBe("192.0.2.1");
  });

  it("refuses a missing, malformed or untrusted forwarded address", () => {
    for (const value of [undefined, "invalid", "192.0.2.1, invalid"])
      expect(() => clientAddress(forwarded(value), 1)).toThrow(/No client address/);
    expect(() => clientAddress(forwarded("192.0.2.1"), 0)).toThrow(/No client address/);
    expect(() => clientAddress(forwarded("192.0.2.1"), 2)).toThrow(/No client address/);
  });
});
