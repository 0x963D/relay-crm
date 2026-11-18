import { afterEach, expect, it, vi } from "vitest";
import { PhoneEntries } from "../src/core/phone-entries.ts";
import type { Answer, Scope } from "../src/core/write-model.ts";
import {
  command,
  draft,
  FakePhone,
  flush,
  id,
  key,
  now,
  pending,
  scope,
} from "./write-fixtures.ts";

afterEach(() => vi.useRealTimers());
it.each(["storing", "sending", "afterReceipt"] as const)(
  "refuses a stale background draft while %s and keeps exactly one save",
  async (phase) => {
    const { owner, storage, dispatch } = await setup();
    let release: () => void = () => undefined;
    if (phase === "storing") {
      storage.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    const saving = owner.save(command, draft, false);
    await flush();
    if (phase !== "storing") await saving;
    if (phase === "afterReceipt")
      await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
    const background = owner.keepDraft(draft, id, "attempt");
    release();
    await saving;
    await background;
    if (phase !== "afterReceipt")
      await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
    expect(storage.saved().drafts).toEqual({});
    expect(owner.draft(id, "attempt")).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  },
);
async function setup(
  storage = new FakePhone(),
  dispatch = vi.fn<() => Promise<Answer>>(() => new Promise<never>(() => undefined)),
  identity: () => Scope | null = () => scope,
) {
  const owner = new PhoneEntries({
    reportError: vi.fn(),
    scope,
    storage,
    dispatch,
    identity,
    now: () => now,
    storageTimeoutMs: 50,
    requestTimeoutMs: 100,
  });
  await owner.restore();
  return { owner, storage, dispatch };
}
it("confirms the entry and key and removes its draft atomically before dispatch", async () => {
  const { owner, storage, dispatch } = await setup();
  await owner.keepDraft(draft, id, "attempt");
  dispatch.mockImplementation(() => {
    storage.trace.push("dispatch");
    expect(storage.saved().entries[id]?.command.payload.key).toBe(key);
    expect(storage.saved().entries[id]?.attempt).toBe(1);
    expect(storage.saved().drafts).toEqual({});
    return new Promise<never>(() => undefined);
  });
  await owner.save(command, draft, false);
  expect(storage.trace.slice(-3)).toEqual(["store:start", "store:confirmed", "dispatch"]);
  expect(dispatch).toHaveBeenCalledWith(command, expect.any(AbortSignal));
});
it("dispatches nothing while initial storage is pending or rejected", async () => {
  const { owner, storage, dispatch } = await setup();
  let release: () => void = () => undefined;
  storage.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = owner.save(command, draft, false);
  await flush();
  expect(owner.snapshot(id).state).toBe("storing");
  expect(dispatch).not.toHaveBeenCalled();
  release();
  await saving;
  expect(dispatch).toHaveBeenCalledTimes(1);
  const rejected = await setup();
  rejected.storage.failure = 1;
  await rejected.owner.save(command, draft, false);
  expect(rejected.dispatch).not.toHaveBeenCalled();
  expect(rejected.owner.snapshot(id).state).toBe("storageFailed");
});
it("times out a store without dispatch, even if the abandoned store later commits", async () => {
  vi.useFakeTimers();
  const { owner, storage, dispatch } = await setup();
  let release: () => void = () => undefined;
  storage.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const saving = owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(51);
  await saving;
  expect(owner.snapshot(id).state).toBe("storageFailed");
  release();
  await flush();
  expect(dispatch).not.toHaveBeenCalled();
  const restored = await setup(storage);
  expect(restored.owner.snapshot(id)).toMatchObject({
    state: "unknown",
    entry: { command, attempt: 1 },
  });
});
it.each(["beforeStore", "afterStore", "afterDispatch", "afterTimeout", "afterRetryStore"] as const)(
  "restores conservatively when killed at %s",
  async (step) => {
    vi.useFakeTimers();
    const { owner, storage, dispatch } = await setup();
    await owner.keepDraft(draft, id, "attempt");
    if (step !== "beforeStore") await owner.save(command, draft, step === "afterStore");
    if (step === "afterTimeout" || step === "afterRetryStore")
      await vi.advanceTimersByTimeAsync(101);
    if (step === "afterRetryStore") await owner.retry(id, false);
    const restored = await setup(storage);
    if (step === "beforeStore") expect(restored.owner.draft(id, "attempt")).toEqual(draft);
    else if (step === "afterStore")
      expect(restored.owner.snapshot(id).state).toBe("neverSubmitted");
    else
      expect(restored.owner.snapshot(id)).toMatchObject({
        state: "unknown",
        entry: { command, attempt: step === "afterRetryStore" ? 2 : 1 },
      });
    expect(restored.dispatch).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(
      step === "beforeStore" || step === "afterStore" ? 0 : step === "afterRetryStore" ? 2 : 1,
    );
  },
);
it("stores the retry number and uncertainty before dispatch and keeps the exact key and payload", async () => {
  vi.useFakeTimers();
  const { owner, storage, dispatch } = await setup();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(101);
  dispatch.mockImplementation(() => {
    expect(storage.saved().entries[id]).toMatchObject({
      attempt: 2,
      followsUnknown: true,
      status: "sending",
      command,
    });
    return new Promise<never>(() => undefined);
  });
  await owner.retry(id, false);
  expect(dispatch).toHaveBeenNthCalledWith(2, command, expect.any(AbortSignal));
});
it("a failed retry store sends nothing and leaves the last stored state", async () => {
  vi.useFakeTimers();
  const { owner, storage, dispatch } = await setup();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(101);
  storage.failure = storage.writes + 1;
  await owner.retry(id, false);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(owner.snapshot(id)).toMatchObject({ state: "unknown", storageError: "retry" });
  expect(storage.saved().entries[id]?.attempt).toBe(1);
});
it.each(["unknown", "refused", "notSaved", "receipt"] as const)(
  "keeps safe disk state when persisting %s fails",
  async (answer) => {
    const { owner, storage } = await setup();
    await owner.save(command, draft, false);
    storage.failure = storage.writes + 1;
    const value: Answer =
      answer === "unknown"
        ? { kind: "unknown", cause: "network" }
        : answer === "refused"
          ? { kind: "refused", reason: "accessDenied" }
          : answer === "notSaved"
            ? { kind: "401" }
            : { kind: "receipt", receipt: { id, accountId: null } };
    await owner.answer(key, 1, value);
    expect(storage.saved().entries[id]?.status).toBe("sending");
    expect(owner.snapshot(id).storageError).toBe(answer === "receipt" ? "remove" : "record");
    const restored = await setup(storage);
    expect(restored.owner.snapshot(id).state).toBe("unknown");
    await owner.repair(id);
    expect(owner.snapshot(id).storageError).toBeNull();
  },
);
it("releases a lead only after a confirmed discard and keeps the delete action on failure", async () => {
  const { owner, storage } = await setup();
  await owner.save(command, draft, true);
  storage.failure = storage.writes + 1;
  await owner.discard(id);
  expect(owner.entries()).toHaveLength(1);
  expect(owner.snapshot(id).storageError).toBe("remove");
  await owner.discard(id);
  expect(owner.entries()).toHaveLength(0);
});
it("makes an unsent entry editable only after it has been stored as a draft", async () => {
  const { owner, storage } = await setup();
  await owner.save(command, draft, true);
  storage.failure = storage.writes + 1;
  await owner.edit(id);
  expect(owner.snapshot(id).state).toBe("neverSubmitted");
  expect(owner.draft(id, "attempt")).toBeNull();
  await owner.repair(id);
  expect(owner.snapshot(id).state).toBe("editing");
  const restored = await setup(storage);
  expect(restored.owner.snapshot(id).state).toBe("editing");
  expect(restored.owner.draft(id, "attempt")).toEqual(draft);
});
it("never makes an unknown or refused entry editable", async () => {
  vi.useFakeTimers();
  const { owner } = await setup();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(101);
  await expect(owner.edit(id)).rejects.toThrow();
  await owner.answer(key, 1, { kind: "refused", reason: "accessDenied" });
  await expect(owner.edit(id)).rejects.toThrow();
});
it("holds one entry per lead across operations and preserves other drafts", async () => {
  const { owner } = await setup();
  await owner.keepDraft({ ...draft, operation: "note" }, id, "note");
  await owner.save(command, draft, true);
  await expect(
    owner.save(
      { operation: "note", payload: { id, key, note: "Other note" } },
      { ...draft, operation: "note" },
      true,
    ),
  ).rejects.toThrow("Review");
  await owner.discard(id);
  expect(owner.draft(id, "note")?.note).toBe(draft.note);
});
it("a receipt from an earlier attempt wins while a retry is in flight", async () => {
  vi.useFakeTimers();
  const { owner } = await setup();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(101);
  await owner.retry(id, false);
  await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
  await owner.answer(key, 2, { kind: "refused", reason: "accessDenied" });
  expect(owner.snapshot(id).state).toBe("saved");
  expect(owner.entries()).toEqual([]);
});
it("defers a late receipt until retry storage settles, then dispatches nothing", async () => {
  vi.useFakeTimers();
  const { owner, storage, dispatch } = await setup();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(101);
  let release: () => void = () => undefined;
  storage.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retrying = owner.retry(id, false);
  await flush();
  await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
  release();
  await retrying;
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(owner.snapshot(id).state).toBe("saved");
});
it("a refusal answers only the latest attempt, and refused after unknown rejects even late receipts", async () => {
  vi.useFakeTimers();
  const { owner } = await setup();
  await owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(101);
  await owner.retry(id, false);
  await owner.answer(key, 1, { kind: "refused", reason: "accessDenied" });
  expect(owner.snapshot(id).state).toBe("sendingRetry");
  await owner.answer(key, 2, { kind: "refused", reason: "accessDenied" });
  await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
  expect(owner.snapshot(id).state).toBe("refusedAfterUnknown");
});
it.each(["person", "server", "removed"] as const)(
  "ignores answers after the entry changes %s",
  async (kind) => {
    let identity: Scope | null = scope;
    const { owner } = await setup(
      new FakePhone(),
      vi.fn<() => Promise<Answer>>(() => new Promise<never>(() => undefined)),
      () => identity,
    );
    await owner.save(command, draft, true);
    if (kind === "removed") {
      await owner.discard(id);
    } else {
      await owner.retry(id, false);
      identity = { ...scope, [kind]: "someone-else" };
    }
    await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
    expect(owner.snapshot(id).state).not.toBe("saved");
  },
);
it("a retry's 401 preserves uncertainty, and a first 401 can safely become a draft", async () => {
  vi.useFakeTimers();
  const { owner } = await setup();
  await owner.save(command, draft, false);
  await owner.answer(key, 1, { kind: "401" });
  expect(owner.snapshot(id).state).toBe("notSaved");
  await owner.retry(id, false);
  await vi.advanceTimersByTimeAsync(101);
  await owner.retry(id, false);
  await owner.answer(key, 3, { kind: "401" });
  expect(owner.snapshot(id)).toMatchObject({ state: "unknown", entry: { followsUnknown: true } });
});
it("sign-out removes only the named server and person, and failed removal preserves data", async () => {
  const { owner, storage } = await setup();
  await owner.keepDraft(draft, id, "attempt");
  storage.failure = storage.writes + 1;
  await expect(owner.removeAll()).rejects.toThrow();
  expect(owner.counts().drafts).toBe(1);
  await owner.removeAll();
  expect(owner.counts()).toEqual({ entries: 0, drafts: 0 });
});
it("a repaired status cannot overwrite a later dispatch", async () => {
  vi.useFakeTimers();
  const { owner, storage } = await setup();
  await owner.save(command, draft, false);
  storage.failure = storage.writes + 1;
  await owner.answer(key, 1, { kind: "unknown", cause: "network" });
  await owner.retry(id, false);
  await owner.repair(id);
  expect(storage.saved().entries[id]).toMatchObject({
    attempt: 2,
    status: "sending",
    followsUnknown: true,
  });
});
it("an old draft callback cannot recreate a removed phone store", async () => {
  const { owner, storage } = await setup();
  await owner.keepDraft(draft, id, "attempt");
  await owner.removeAll();
  await expect(owner.keepDraft(draft, id, "attempt")).rejects.toThrow("removed");
  expect(storage.saved().drafts).toEqual({});
});
it("freezes the stored payload against later edits to the caller's draft and command", async () => {
  const { owner, storage } = await setup();
  const mutableDraft = structuredClone(draft);
  const mutableCommand = structuredClone(command);
  if (mutableCommand.operation !== "attempt") throw new Error("Expected an attempt.");
  await owner.save(mutableCommand, mutableDraft, true);
  mutableDraft.note = "Changed later";
  mutableCommand.payload.note = "Changed later";
  expect(storage.saved().entries[id]?.draft.note).toBe(draft.note);
  expect(owner.snapshot(id).entry?.draft.note).toBe(draft.note);
  expect(owner.snapshot(id).entry?.command).toEqual(command);
});
it.each(["draft", "save", "retry", "answer", "receipt", "edit", "discard"] as const)(
  "restores safely on either side of the %s storage confirmation",
  async (step) => {
    vi.useFakeTimers();
    for (const lands of [false, true]) {
      let identity: Scope | null = scope;
      const { owner, storage, dispatch } = await setup(
        new FakePhone(),
        vi.fn<() => Promise<Answer>>(() => new Promise<never>(() => undefined)),
        () => identity,
      );
      if (step !== "draft") await owner.keepDraft(draft, id, "attempt");
      if (!["draft", "save"].includes(step))
        await owner.save(command, draft, step === "edit" || step === "discard");
      if (step === "retry") await owner.answer(key, 1, { kind: "unknown", cause: "network" });
      const callsBefore = dispatch.mock.calls.length;
      let release: () => void = () => undefined;
      storage.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!lands) storage.failure = storage.writes + 1;
      const operation =
        step === "draft"
          ? owner.keepDraft(draft, id, "attempt")
          : step === "save"
            ? owner.save(command, draft, false)
            : step === "retry"
              ? owner.retry(id, false)
              : step === "answer"
                ? owner.answer(key, 1, { kind: "unknown", cause: "network" })
                : step === "receipt"
                  ? owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } })
                  : step === "edit"
                    ? owner.edit(id)
                    : owner.discard(id);
      const settled = operation.catch(() => undefined);
      await flush();
      identity = null;
      release();
      await settled;
      const restored = await setup(storage);
      expect(dispatch).toHaveBeenCalledTimes(callsBefore);
      if (step === "draft")
        expect(restored.owner.draft(id, "attempt")).toEqual(lands ? draft : null);
      else if (step === "save" && !lands)
        expect(restored.owner.draft(id, "attempt")).toEqual(draft);
      else if ((step === "receipt" || step === "discard") && lands)
        expect(restored.owner.entries()).toEqual([]);
      else if (step === "edit" && lands) expect(restored.owner.draft(id, "attempt")).toEqual(draft);
      else
        expect(restored.owner.snapshot(id)).toMatchObject({
          state: step === "edit" || step === "discard" ? "neverSubmitted" : "unknown",
          entry: { command },
        });
    }
  },
);
it("keeps the old draft if a draft update or removal fails", async () => {
  const { owner, storage } = await setup();
  await owner.keepDraft(draft, id, "attempt");
  storage.failure = storage.writes + 1;
  await expect(owner.keepDraft({ ...draft, note: "New text" }, id, "attempt")).rejects.toThrow();
  expect(owner.draft(id, "attempt")).toEqual(draft);
  storage.failure = storage.writes + 1;
  await expect(owner.keepDraft(null, id, "attempt")).rejects.toThrow();
  expect(owner.draft(id, "attempt")).toEqual(draft);
});

it("a slow close and its later receipt cannot restore the closing draft", async () => {
  vi.useFakeTimers();
  const { owner, storage, dispatch } = await setup();
  const closing = { ...draft, operation: "close", closing: "won" } as const;
  const close = { operation: "close", payload: { id, key, closing: { kind: "won" } } } as const;
  await owner.keepDraft(closing, id, "close");
  await owner.save(close, closing, false);
  await vi.advanceTimersByTimeAsync(600);
  await owner.keepDraft(closing, id, "close");
  await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
  expect(storage.saved().drafts).toEqual({});
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("debounces drafts in the owner and flushes the latest text when leaving the foreground", async () => {
  vi.useFakeTimers();
  const { owner, storage } = await setup();
  owner.updateDraft(draft, id, "attempt");
  await vi.advanceTimersByTimeAsync(499);
  expect(storage.writes).toBe(0);
  const latest = { ...draft, note: "Latest" };
  owner.updateDraft(latest, id, "attempt");
  await owner.background();
  expect(owner.draft(id, "attempt")).toEqual(latest);
  await vi.advanceTimersByTimeAsync(600);
  expect(storage.writes).toBe(1);
});
it.each(["storing", "sending", "close"] as const)(
  "stops the owner draft lifecycle on Save during %s",
  async (phase) => {
    vi.useFakeTimers();
    const { owner, storage, dispatch } = await setup();
    const typed =
      phase === "close" ? ({ ...draft, operation: "close", closing: "won" } as const) : draft;
    const saved =
      phase === "close"
        ? ({ operation: "close", payload: { id, key, closing: { kind: "won" } } } as const)
        : command;
    owner.updateDraft(typed, id, typed.operation);
    const gate = Promise.withResolvers<undefined>();
    if (phase === "storing") storage.gate = gate.promise;
    const saving = owner.save(saved, typed, false);
    await flush();
    await owner.background();
    gate.resolve(undefined);
    await saving;
    await vi.advanceTimersByTimeAsync(600);
    await owner.background();
    await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
    await vi.advanceTimersByTimeAsync(600);
    expect(owner.draft(id, typed.operation)).toBeNull();
    expect(storage.saved().drafts).toEqual({});
    expect(dispatch).toHaveBeenCalledTimes(1);
  },
);
it("discard removes a late-landing initial store without sending it", async () => {
  vi.useFakeTimers();
  const { owner, storage, dispatch } = await setup();
  const gate = Promise.withResolvers<undefined>();
  storage.gate = gate.promise;
  const saving = owner.save(command, draft, false);
  await vi.advanceTimersByTimeAsync(51);
  await saving;
  gate.resolve(undefined);
  await flush();
  await owner.discardDraft(id, "attempt");
  await vi.advanceTimersByTimeAsync(600);
  expect(storage.saved().entries).toEqual({});
  expect(storage.saved().drafts).toEqual({});
  expect(dispatch).not.toHaveBeenCalled();
});
it("a wrong-lead receipt becomes unknown instead of leaving Sending stuck", async () => {
  const dispatch = vi.fn<() => Promise<Answer>>();
  const { owner } = await setup(new FakePhone(), dispatch);
  dispatch.mockResolvedValueOnce({
    kind: "receipt",
    receipt: { id: "00000000-0000-4000-8000-000000000003", accountId: null },
  });
  await owner.save(command, draft, false);
  await flush();
  expect(owner.snapshot(id)).toMatchObject({
    state: "unknown",
    entry: { unknownCause: "unreadable" },
  });
});
it("reports an impossible event once through the same path used by UI and transport", async () => {
  const reportError = vi.fn();
  const owner = new PhoneEntries({
    scope,
    storage: new FakePhone(),
    identity: () => scope,
    dispatch: pending(),
    now: () => now,
    reportError,
  });
  await owner.restore();
  await owner.save(command, draft, true);
  owner.run(() => owner.retry(id, false));
  await flush();
  owner.run(() => owner.discard(id));
  await flush();
  expect(reportError).toHaveBeenCalledTimes(1);
  expect(reportError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  expect(owner.snapshot(id).state).toBe("sendingFirst");
});
it("writes the recovered sending status back as unknown", async () => {
  const { owner, storage } = await setup();
  await owner.save(command, draft, false);
  const restored = await setup(storage);
  expect(restored.owner.snapshot(id).state).toBe("unknown");
  expect(storage.saved().entries[id]).toMatchObject({
    status: "unknown",
    unknownCause: "interrupted",
  });
});

it("retries a failed draft flush on background and never resurrects a discarded flush", async () => {
  vi.useFakeTimers();
  const { owner, storage } = await setup();
  owner.updateDraft(draft, id, "attempt");
  storage.failure = 1;
  await vi.advanceTimersByTimeAsync(500);
  expect(owner.draftFailed(id, "attempt")).toBe(true);
  await owner.background();
  expect(owner.draftFailed(id, "attempt")).toBe(false);
  expect(owner.draft(id, "attempt")).toEqual(draft);
  const gate = Promise.withResolvers<undefined>();
  storage.gate = gate.promise;
  storage.failure = storage.writes + 1;
  owner.updateDraft({ ...draft, note: "discard this" }, id, "attempt");
  const flushing = owner.background();
  await flush();
  const discarding = owner.discardDraft(id, "attempt");
  gate.resolve(undefined);
  await Promise.all([flushing, discarding]);
  await owner.background();
  expect(owner.draft(id, "attempt")).toBeNull();
});
it("reports a failure processing a transport answer through the same action boundary", async () => {
  const reportError = vi.fn();
  const dispatch = vi
    .fn<() => Promise<Answer>>()
    .mockResolvedValue({ kind: "receipt", receipt: { id, accountId: null } });
  const owner = new PhoneEntries({
    scope,
    storage: new FakePhone(),
    identity: () => scope,
    dispatch,
    now: () => now,
    reportError,
  });
  await owner.restore();
  const error = new Error("An impossible answer event");
  vi.spyOn(owner, "answer").mockRejectedValueOnce(error);
  await owner.save(command, draft, false);
  await flush();
  expect(reportError).toHaveBeenCalledExactlyOnceWith(error);
});

it("cannot start a second save from a completed form before a new form begins", async () => {
  const { owner, dispatch } = await setup();
  await owner.save(command, draft, false);
  await owner.answer(key, 1, { kind: "receipt", receipt: { id, accountId: null } });
  await expect(owner.save(command, draft, false)).rejects.toThrow("saved/save");
  expect(dispatch).toHaveBeenCalledTimes(1);
});
