import { expect, it } from "vitest";
import { canOfferCall, handoffTarget } from "../src/core/handoff.ts";

it.each([
  "*#06#",
  "123;456",
  "123#456",
  "123?456",
  "123/456",
  "12",
  "112",
  "+44(0)20 7946 0958",
  "+1234567890123456",
  "++441234567890",
])("rejects dialler input %s", (phone) => {
  expect(handoffTarget("call", phone)).toBeNull();
});
it.each(["+44 7700 900141", "+44 (7700) 900-141", "+44 [7700] 900.141"])(
  "normalizes %s before opening the dialler",
  (phone) => {
    expect(handoffTarget("call", phone)).toBe("tel:+447700900141");
    expect(handoffTarget("whatsapp", phone)).toBe("https://wa.me/447700900141");
  },
);
it("allows a local call without treating it as a WhatsApp country code", () => {
  expect(handoffTarget("call", "123-4567")).toBe("tel:1234567");
  expect(handoffTarget("whatsapp", "123-4567")).toBeNull();
});
it("disables short-code calls and offers recovery for an ambiguous international number", () => {
  expect(canOfferCall("112")).toBe(false);
  expect(canOfferCall(null)).toBe(false);
  expect(canOfferCall("+44(0)20 7946 0958")).toBe(true);
  expect(handoffTarget("call", "+44(0)20 7946 0958")).toBeNull();
});
