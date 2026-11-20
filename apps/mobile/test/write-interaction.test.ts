import { expect, it } from "vitest";
import { WriteInteraction } from "../src/core/write-interaction.ts";
import { command } from "./write-fixtures.ts";
it("requires a full confirmation guard, consumes it once and withdraws on background or Back", () => {
  let now = 0;
  const form = new WriteInteraction(() => now);
  form.confirm(command);
  now = 399;
  expect(form.accept(true)).toBeNull();
  now = 400;
  expect(form.accept(false)).toBeNull();
  expect(form.accept(true)).toEqual(command);
  expect(form.accept(true)).toBeNull();
  form.confirm(command);
  form.withdraw();
  now = 1000;
  expect(form.accept(true)).toBeNull();
});
it("keeps a fast answer busy for 400 ms without delaying a slow answer", () => {
  let now = 0;
  const form = new WriteInteraction(() => now);
  form.startBusy();
  now = 50;
  expect(form.displayDelay("saved")).toBe(350);
  expect(form.displayDelay("sendingFirst")).toBe(0);
  now = 600;
  expect(form.displayDelay("saved")).toBe(0);
});
it("starts a handoff once after presentation and initialization, never for a held entry", () => {
  const form = new WriteInteraction(() => 0);
  expect(form.startHandoff(false, "+40123456789", true, false)).toBe(false);
  expect(form.startHandoff(true, undefined, true, false)).toBe(false);
  expect(form.startHandoff(true, "+40123456789", false, false)).toBe(false);
  expect(form.startHandoff(true, "+40123456789", true, true)).toBe(false);
  expect(form.startHandoff(true, "+40123456789", true, false)).toBe(true);
  expect(form.startHandoff(true, "+40123456789", true, false)).toBe(false);
});
