import { vi } from "vitest";
import { emptyPhone } from "../src/core/write-model.ts";
import type { Command, Draft, PhoneData, Scope } from "../src/core/write-model.ts";
import type { PhoneStorage } from "../src/core/phone-entries.ts";
export const scope: Scope = { server: "https://relay.example", person: "person" };
export const id = "00000000-0000-4000-8000-000000000001";
export const key = "00000000-0000-4000-8000-000000000002";
export const now = new Date("2026-11-17T12:00:00Z");
export const draft: Draft = {
  id,
  operation: "attempt",
  leadName: "A lead",
  note: "Rang out",
  channel: "call",
  outcome: "noAnswer",
  callbackAt: null,
  closing: null,
  reason: null,
  handoff: null,
  changedAt: now.toISOString(),
};
export const command: Command = {
  operation: "attempt",
  payload: { id, key, channel: "call", outcome: "noAnswer", note: draft.note },
};
export class FakePhone implements PhoneStorage {
  readonly rows = new Map<string, PhoneData>();
  readonly trace: string[] = [];
  failure = 0;
  writes = 0;
  gate: Promise<void> | null = null;
  private address(owner: Scope) {
    return JSON.stringify(owner);
  }
  async load(owner: Scope) {
    await Promise.resolve();
    this.trace.push("load");
    return structuredClone(this.rows.get(this.address(owner)) ?? null);
  }
  async replace(owner: Scope, data: PhoneData) {
    this.trace.push("store:start");
    this.writes += 1;
    const fail = this.failure === this.writes;
    if (this.gate) await this.gate;
    if (fail) throw new Error("Storage rejected.");
    this.rows.set(this.address(owner), structuredClone(data));
    this.trace.push("store:confirmed");
  }
  async remove(owner: Scope) {
    this.trace.push("remove");
    this.writes += 1;
    if (this.failure === this.writes) throw new Error("Delete rejected.");
    await Promise.resolve();
    this.rows.delete(this.address(owner));
  }
  saved() {
    return this.rows.get(this.address(scope)) ?? emptyPhone();
  }
}
export const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};
export const pending = () => vi.fn(() => new Promise<never>(() => undefined));
