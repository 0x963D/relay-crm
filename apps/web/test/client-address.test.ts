import { describe, expect, it } from "vitest";
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
});
