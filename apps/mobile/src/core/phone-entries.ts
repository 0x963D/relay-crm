import { transitionWrite } from "./write-machine.ts";
import type { WriteContext, WriteEvent, WriteState } from "./write-machine.ts";
import {
  commandSchema,
  draftSchema,
  draftKey,
  emptyPhone,
  sameScope,
  stateOf,
} from "./write-model.ts";
import type {
  Answer,
  Command,
  Draft,
  Entry,
  PhoneData,
  Scope,
  WriteSnapshot,
} from "./write-model.ts";

export interface PhoneStorage {
  load(scope: Scope): Promise<PhoneData | null>;
  replace(scope: Scope, data: PhoneData): Promise<void>;
  remove(scope: Scope): Promise<void>;
}
interface Options {
  readonly scope: Scope;
  readonly storage: PhoneStorage;
  readonly identity: () => Scope | null;
  readonly dispatch: (command: Command, signal: AbortSignal) => Promise<Answer>;
  readonly now: () => Date;
  readonly reportError: (error: unknown) => void;
  readonly sessionEnded?: () => void;
  readonly storageTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}
const without = <T>(items: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(items).filter(([name]) => name !== key));
const editing = (): WriteSnapshot => ({
  state: "editing",
  view: "unchanged",
  entry: null,
  storageError: null,
  receipt: null,
});
const idleSnapshot = editing();
const busy = (state: WriteState) =>
  state === "storing" || state === "sendingFirst" || state === "sendingRetry";
const lateAnswerMs = 120000;

export async function confirmStorage<T>(work: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Storage did not confirm."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class PhoneEntries {
  private data = emptyPhone();
  private loaded = false;
  private retired = false;
  private tail = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<string, WriteSnapshot>();
  private readonly deferred = new Map<string, Extract<Answer, { kind: "receipt" }>>();
  private readonly repairs = new Map<string, () => Promise<unknown>>();
  private readonly requests = new Set<() => void>();
  private readonly drafts = new Map<
    string,
    {
      id: string;
      operation: Draft["operation"];
      draft: Draft | null;
      timer: ReturnType<typeof setTimeout>;
      work: Promise<void> | null;
    }
  >();
  private readonly draftErrors = new Set<string>();
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    if (this.retired) return;
    for (const listener of this.listeners) listener();
  }
  private show(id: string, snapshot: WriteSnapshot) {
    if (this.retired) return;
    this.views.set(id, snapshot);
    this.emit();
  }
  snapshot(id: string): WriteSnapshot {
    return this.views.get(id) ?? idleSnapshot;
  }
  begin(id: string) {
    if (this.retired) return;
    if (!this.data.entries[id] && this.snapshot(id).state === "saved") {
      this.views.delete(id);
      this.emit();
    }
  }
  entries() {
    return Object.values(this.data.entries).sort((a, b) => a.savedAt.localeCompare(b.savedAt));
  }
  counts() {
    return { entries: this.entries().length, drafts: Object.keys(this.data.drafts).length };
  }
  run(work: () => Promise<unknown>) {
    if (this.retired) return;
    void (async () => work())().catch((error: unknown) => {
      if (!this.retired) this.options.reportError(error);
    });
  }
  draftFailed(id: string, operation: Draft["operation"]) {
    return this.draftErrors.has(draftKey(id, operation));
  }
  private canDraft(id: string, operation: Draft["operation"]) {
    const state = this.snapshot(id).state;
    const entry = this.data.entries[id];
    return entry
      ? state === "storageFailed" && entry.command.operation === operation
      : state === "editing" || state === "storageFailed";
  }
  private stopDrafts(id: string) {
    for (const [key, pending] of this.drafts) {
      if (pending.id !== id) continue;
      clearTimeout(pending.timer);
      this.drafts.delete(key);
    }
  }
  updateDraft(draft: Draft | null, id: string, operation: Draft["operation"]) {
    if (this.retired) return;
    const key = draftKey(id, operation);
    if (!this.canDraft(id, operation)) {
      this.draftErrors.add(key);
      this.emit();
      return;
    }
    clearTimeout(this.drafts.get(key)?.timer);
    this.drafts.set(key, {
      id,
      operation,
      draft: draft ? draftSchema.parse(draft) : null,
      work: null,
      timer: setTimeout(() => {
        this.run(() => this.flushDraft(id, operation));
      }, 500),
    });
  }
  async flushDraft(id: string, operation: Draft["operation"]) {
    if (this.retired) return;
    const key = draftKey(id, operation);
    const pending = this.drafts.get(key);
    if (!pending) return;
    if (pending.work) return pending.work;
    clearTimeout(pending.timer);
    pending.work = (async () => {
      try {
        if (!(await this.keepDraft(pending.draft, id, operation))) {
          if (this.drafts.get(key) === pending) this.draftErrors.add(key);
          return;
        }
        if (this.drafts.get(key) === pending) {
          this.drafts.delete(key);
          this.draftErrors.delete(key);
        }
      } catch {
        if (this.drafts.get(key) === pending) this.draftErrors.add(key);
      } finally {
        pending.work = null;
        this.emit();
      }
    })();
    await pending.work;
  }
  async background() {
    await Promise.all(
      [...this.drafts.values()].map(({ id, operation }) => this.flushDraft(id, operation)),
    );
  }
  draft(id: string, operation: Draft["operation"]) {
    return this.data.drafts[draftKey(id, operation)] ?? null;
  }
  private active() {
    return !this.retired && sameScope(this.options.identity(), this.options.scope);
  }
  private context(entry: Entry | null, extra: Partial<WriteContext> = {}): WriteContext {
    return {
      operation: entry?.command.operation ?? "attempt",
      valid: true,
      signedIn: true,
      offline: false,
      clearCallback:
        entry?.command.operation === "callback" && entry.command.payload.change.kind === "clear",
      prior: "editing",
      followsUnknown: entry?.followsUnknown ?? false,
      landed: true,
      landedStatus: entry?.status === "neverSubmitted" ? "neverSubmitted" : "sending",
      hasContent: true,
      copyKept: false,
      latest: true,
      answer: "ok",
      ...extra,
    };
  }
  private commit(change: (data: PhoneData) => PhoneData) {
    const work = this.tail.then(async () => {
      if (this.retired) throw new Error("This phone store has been retired.");
      if (!this.loaded) throw new Error("Phone storage has not loaded.");
      const next = change(this.data);
      if (next === this.data) return false;
      await this.options.storage.replace(this.options.scope, next);
      this.data = next;
      this.emit();
      return true;
    });
    this.tail = work.then(
      () => undefined,
      () => undefined,
    );
    return confirmStorage(work, this.options.storageTimeoutMs);
  }
  async restore(prior?: PhoneEntries) {
    const predecessor =
      prior?.retired && sameScope(prior.options.scope, this.options.scope) ? prior : undefined;
    await predecessor?.tail;
    await this.tail;
    const data = await this.options.storage.load(this.options.scope);
    if (this.retired) return;
    this.data = data ?? emptyPhone();
    this.loaded = true;
    for (const entry of this.entries()) {
      const id = entry.command.payload.id;
      if (predecessor?.snapshot(id).state === "storageFailed") {
        this.show(id, { ...editing(), state: "storageFailed", view: "storageFailed" });
        continue;
      }
      const launch = transitionWrite(stateOf(entry), "relaunch", this.context(entry));
      const restored: Entry =
        entry.status === "sending"
          ? { ...entry, status: "unknown", unknownCause: "interrupted" }
          : entry;
      this.show(id, {
        state: launch.next,
        view: entry.status === "sending" ? "interrupted" : "unchanged",
        entry: restored,
        storageError: null,
        receipt: null,
      });
      if (entry.status === "sending") {
        await this.repairable(
          id,
          () =>
            this.commit((data) => ({
              ...data,
              entries: { ...data.entries, [id]: restored },
            })),
          "record",
        );
      }
    }
    if (predecessor) {
      for (const { draft, id, operation } of predecessor.drafts.values()) {
        this.updateDraft(draft, id, operation);
      }
    }
    this.emit();
  }
  keepDraft(draft: Draft | null, id: string, operation: Draft["operation"]) {
    return this.commit((data) => {
      if (!this.canDraft(id, operation)) return data;
      const key = draftKey(id, operation);
      const drafts = without(data.drafts, key);
      if (draft) drafts[key] = draftSchema.parse(draft);
      // An initial store that missed confirmation was never dispatched.
      const entries = data.entries[id] ? without(data.entries, id) : data.entries;
      return { ...data, drafts, entries };
    });
  }
  async save(command: Command, draft: Draft, offline: boolean) {
    const id = command.payload.id;
    const before = this.snapshot(id);
    if (!this.active() || busy(before.state)) return;
    if (this.data.entries[id] && before.state !== "storageFailed")
      throw new Error("Review the kept entry first.");
    this.stopDrafts(id);
    const decision = transitionWrite(
      before.state,
      before.state === "storageFailed" ? "retry" : "save",
      this.context(null),
    );
    this.show(id, { ...editing(), state: decision.next, view: decision.view });
    const entry: Entry = {
      command: commandSchema.parse(command),
      draft: draftSchema.parse(draft),
      status: offline ? "neverSubmitted" : "sending",
      attempt: offline ? 0 : 1,
      followsUnknown: false,
      refusal: null,
      savedAt: this.options.now().toISOString(),
      unknownCause: null,
    };
    try {
      await this.commit((data) => {
        const drafts = without(data.drafts, draftKey(id, command.operation));
        return { ...data, drafts, entries: { ...data.entries, [id]: entry } };
      });
    } catch {
      const failed = transitionWrite("storing", "storeFail", this.context(null));
      this.show(id, { ...editing(), state: failed.next, view: failed.view });
      this.updateDraft(draft, id, command.operation);
      return;
    }
    this.draftErrors.delete(draftKey(id, command.operation));
    const stored = transitionWrite("storing", "stored", this.context(entry, { offline }));
    this.show(id, { ...editing(), entry, state: stored.next, view: stored.view });
    if (stored.action === "dispatch" && this.active()) this.send(entry);
  }
  async retry(id: string, offline: boolean, signedIn = true) {
    const before = this.snapshot(id);
    const prior = before.entry;
    if (!prior || !this.active() || busy(before.state)) return;
    const decision = transitionWrite(
      before.state,
      "retry",
      this.context(prior, { offline, signedIn }),
    );
    if (decision.action !== "store") return;
    this.repairs.delete(id);
    const entry: Entry = {
      ...prior,
      status: "sending",
      attempt: prior.attempt + 1,
      followsUnknown: prior.followsUnknown || before.state === "unknown",
    };
    this.show(id, { ...before, state: "storing", storageError: null });
    try {
      await this.commit((data) => ({ ...data, entries: { ...data.entries, [id]: entry } }));
    } catch {
      const failure = transitionWrite(
        "storing",
        "storeFail",
        this.context(prior, { prior: before.state }),
      );
      this.show(id, { ...before, state: failure.next, storageError: "retry" });
      const receipt = this.deferred.get(entry.command.payload.key);
      this.deferred.delete(entry.command.payload.key);
      if (receipt) await this.answer(entry.command.payload.key, prior.attempt, receipt);
      return;
    }
    const receipt = this.deferred.get(entry.command.payload.key);
    this.deferred.delete(entry.command.payload.key);
    this.show(id, { ...before, entry, state: stateOf(entry), storageError: null });
    if (receipt) await this.answer(entry.command.payload.key, prior.attempt, receipt);
    else if (this.active()) this.send(entry);
  }
  private send(entry: Entry) {
    const key = entry.command.payload.key;
    const controller = new AbortController();
    const deadline = this.options.requestTimeoutMs ?? 20000;
    const timer = setTimeout(() => {
      this.run(() => this.answer(key, entry.attempt, { kind: "unknown", cause: "timeout" }));
    }, deadline);
    const forget = () => {
      clearTimeout(timer);
      clearTimeout(ceiling);
      this.requests.delete(close);
    };
    const close = () => {
      forget();
      controller.abort();
    };
    const ceiling = setTimeout(close, deadline + lateAnswerMs);
    this.requests.add(close);
    this.run(async () => {
      const answer = await this.options
        .dispatch(entry.command, controller.signal)
        .catch((): Answer => ({ kind: "unknown", cause: "network" }));
      forget();
      if (controller.signal.aborted || !this.active()) return;
      await this.answer(key, entry.attempt, answer);
      if (
        this.active() &&
        (answer.kind === "401" || (answer.kind === "unknown" && answer.sessionEnded))
      )
        this.options.sessionEnded?.();
    });
  }
  async answer(key: string, attempt: number, answer: Answer) {
    if (!this.active()) return;
    const entry = this.entries().find((item) => item.command.payload.key === key);
    if (
      !entry ||
      attempt < 1 ||
      attempt > Math.max(entry.attempt, this.snapshot(entry.command.payload.id).entry?.attempt ?? 0)
    )
      return;
    const id = entry.command.payload.id;
    if (answer.kind === "receipt" && answer.receipt.id !== id)
      answer = { kind: "unknown", cause: "unreadable" };
    const current = this.snapshot(id);
    if (current.state === "storing") {
      if (answer.kind === "receipt" && answer.receipt.id === id) this.deferred.set(key, answer);
      return;
    }
    if (!["sendingFirst", "sendingRetry", "unknown"].includes(current.state)) return;
    const latestEntry = current.entry ?? entry;
    const latest = attempt === latestEntry.attempt;
    if (answer.kind !== "receipt" && !latest) return;
    const event: WriteEvent =
      answer.kind === "receipt"
        ? "ok"
        : answer.kind === "401"
          ? "401"
          : answer.kind === "unknown"
            ? answer.cause === "server"
              ? "unreadable"
              : answer.cause
            : refusalEvent(answer.reason);
    const decision = transitionWrite(
      current.state,
      current.state === "unknown" || !latest ? "late" : event,
      this.context(latestEntry, { latest, answer: event }),
    );
    if (decision.action === "none") return;
    if (decision.next === "saved") {
      this.show(id, {
        ...current,
        state: "saved",
        view: decision.view,
        receipt: answer.kind === "receipt" ? answer.receipt : { id, accountId: null },
      });
      await this.removeSaved(id);
      return;
    }
    if (decision.next === "editing") {
      const correction = async () => {
        await this.toDraft(id, latestEntry);
        this.show(id, { ...editing(), view: decision.view });
      };
      this.show(id, { ...current, state: "refused", view: decision.view });
      await this.repairable(id, correction, "record");
      return;
    }
    const next: Entry = {
      ...latestEntry,
      status:
        decision.next === "notSaved"
          ? "notSaved"
          : decision.next === "unknown"
            ? "unknown"
            : "refused",
      refusal: answer.kind === "refused" ? answer.reason : null,
      unknownCause:
        answer.kind === "unknown" ? answer.cause : answer.kind === "401" ? "session" : null,
    };
    this.show(id, {
      ...current,
      entry: next,
      state: decision.next,
      view: decision.view,
      storageError: null,
    });
    await this.repairable(
      id,
      () => this.commit((data) => ({ ...data, entries: { ...data.entries, [id]: next } })),
      "record",
    );
  }
  private async repairable(id: string, work: () => Promise<unknown>, error: "record" | "remove") {
    if (this.retired) return;
    this.repairs.set(id, work);
    try {
      await work();
      if (this.repairs.get(id) === work) {
        this.repairs.delete(id);
        this.show(id, { ...this.snapshot(id), storageError: null });
      }
    } catch {
      if (this.repairs.get(id) === work)
        this.show(id, { ...this.snapshot(id), storageError: error });
    }
  }
  async repair(id: string) {
    if (this.retired) return;
    const work = this.repairs.get(id);
    if (work)
      await this.repairable(id, work, this.snapshot(id).state === "saved" ? "remove" : "record");
  }
  private async removeSaved(id: string) {
    await this.repairable(id, () => this.deleteEntry(id), "remove");
  }
  private deleteEntry(id: string) {
    return this.commit((data) => {
      const entries = without(data.entries, id);
      return { ...data, entries };
    });
  }
  async discard(id: string) {
    if (this.retired) return;
    const current = this.snapshot(id);
    transitionWrite(current.state, "discard", this.context(current.entry));
    try {
      await this.deleteEntry(id);
      this.views.delete(id);
      this.repairs.delete(id);
      this.emit();
    } catch {
      this.show(id, { ...current, storageError: "remove" });
    }
  }
  async discardDraft(id: string, operation: Draft["operation"]) {
    if (this.retired) return;
    const state = this.snapshot(id).state;
    if (state !== "editing" && state !== "storageFailed")
      throw new Error("Review the kept entry first.");
    this.stopDrafts(id);
    await this.commit((data) => ({
      ...data,
      entries: state === "storageFailed" ? without(data.entries, id) : data.entries,
      drafts: without(data.drafts, draftKey(id, operation)),
    }));
    this.views.delete(id);
    this.draftErrors.delete(draftKey(id, operation));
    this.emit();
  }
  private toDraft(id: string, entry: Entry) {
    return this.commit((data) => {
      const entries = without(data.entries, id);
      return {
        ...data,
        entries,
        drafts: { ...data.drafts, [draftKey(id, entry.command.operation)]: entry.draft },
      };
    });
  }
  async edit(id: string) {
    if (this.retired) return;
    const current = this.snapshot(id);
    const entry = current.entry;
    if (!entry || current.storageError) return;
    transitionWrite(current.state, "edit", this.context(entry));
    await this.repairable(
      id,
      async () => {
        await this.toDraft(id, entry);
        this.show(id, editing());
      },
      "record",
    );
  }
  retire() {
    this.retired = true;
    this.listeners.clear();
    this.repairs.clear();
    this.deferred.clear();
    for (const pending of this.drafts.values()) clearTimeout(pending.timer);
    for (const close of this.requests) close();
  }
}
function refusalEvent(reason: string | null): WriteEvent {
  switch (reason) {
    case null:
      return "other";
    case "accessDenied":
    case "leadClosed":
    case "invalidTransition":
    case "callbackInPast":
    case "callbackNotSet":
      return reason;
    case "wrongNumberNeedsAnAttempt":
      return "wrongNumber";
    case "idempotencyConflict":
      return "conflict";
    default:
      return "other";
  }
}
