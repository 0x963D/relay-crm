import { expect, it } from "vitest";
import { leadContact } from "../src/core/lead.ts";
import type { Lead } from "../src/core/api-types.ts";
import { queue, row } from "./fixtures.ts";

const lead: Lead = {
  ...row,
  contactedAt: null,
  lostNote: null,
  custody: { receivedFrom: null, assignedBy: null, heldBy: null },
  attribution: null,
  timeline: [],
};
it("uses the cached queue header while loading but never enables its phone", () => {
  expect(leadContact(row.id, undefined, queue(), false)).toEqual({
    name: row.name,
    phone: row.phone,
    email: row.email,
    callablePhone: null,
  });
});
it("enables only the phone returned by a successful read for that lead", () => {
  expect(leadContact(row.id, { ...lead, phone: "+123456789" }, queue(), false).callablePhone).toBe(
    "+123456789",
  );
  expect(leadContact(row.id, lead, queue(), true).callablePhone).toBeNull();
  expect(leadContact("different", lead, queue(), false).callablePhone).toBeNull();
});
it("keeps a server's missing phone instead of restoring the queue's older number", () => {
  expect(leadContact(row.id, { ...lead, phone: null }, queue(), false).phone).toBeNull();
});
