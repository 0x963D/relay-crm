import { expect, it } from "vitest";
import { serverOrigin } from "../src/api/server.ts";

it.each([
  "localhost",
  "127.0.0.1",
  "127.2.3.4",
  "10.0.2.2",
  "10.12.1.2",
  "172.16.0.1",
  "172.31.255.254",
  "192.168.1.2",
  "[::1]",
  "[fd12::1]",
])("allows local HTTP at %s", (host) => {
  expect(serverOrigin(`http://${host}:3107`)).toBe(`http://${host}:3107`);
});
it.each([
  "relay.example",
  "8.8.8.8",
  "172.15.1.1",
  "172.32.1.1",
  "192.169.1.1",
  "[2001:4860::1]",
  "[cddd::1]",
  "localhost.example",
])("requires HTTPS at %s", (host) => {
  expect(() => serverOrigin(`http://${host}`)).toThrow("requires HTTPS");
  expect(serverOrigin(`https://${host}`)).toBe(`https://${host}`);
});
it.each([
  "https://user@relay.example",
  "https://relay.example/path",
  "https://relay.example?token=x",
  "ftp://relay.example",
])("rejects a non-origin configuration %s", (origin) => {
  expect(() => serverOrigin(origin)).toThrow();
});
