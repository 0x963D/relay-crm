import { transitionWrite } from "./write-machine.ts";
import type { WriteContext, WriteEvent } from "./write-machine.ts";
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
export class PhoneEntries {
  private data = emptyPhone();
  private loaded = false;
  private removed = false;
  private tail = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly views = new Map<string, WriteSnapshot>();
  private readonly deferred = new Map<string, Extract<Answer, { kind: "receipt" }>>();
  private readonly repairs = new Map<string, () => Promise<void>>();
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
    for (const listener of this.listeners) listener();
  }
  private show(id: string, snapshot: WriteSnapshot) {
    this.views.set(id, snapshot);
    this.emit();
  }
  snapshot(id: string): WriteSnapshot {
    return this.views.get(id) ?? editing();
  }
  begin(id: string) {
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
  draft(id: string, operation: Draft["operation"]) {
    return this.data.drafts[draftKey(id, operation)] ?? null;
  }
  private active() {
    return sameScope(this.options.identity(), this.options.scope);
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
      hasContent: true,
      copyKept: false,
      latest: true,
      answer: "ok",
      ...extra,
    };
  }
  private async confirmed(work: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Storage did not confirm."));
          }, this.options.storageTimeoutMs ?? 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private commit(change: (data: PhoneData) => PhoneData) {
    const work = this.tail.then(async () => {
      if (!this.loaded) throw new Error("Phone storage has not loaded.");
      if (this.removed) throw new Error("This phone store has been removed.");
      const next = change(this.data);
      await this.options.storage.replace(this.options.scope, next);
      this.data = next;
      this.emit();
    });
    this.tail = work.catch(() => undefined);
    return this.confirmed(work);
  }
  async restore() {
    await this.tail;
    this.data = (await this.options.storage.load(this.options.scope)) ?? emptyPhone();
    this.loaded = true;
    for (const entry of this.entries()) {
      const launch = transitionWrite(stateOf(entry), "relaunch", this.context(entry));
      const restored: Entry =
        entry.status === "sending"
          ? { ...entry, status: "unknown", unknownCause: "interrupted" }
          : entry;
      this.show(entry.command.payload.id, {
        state: launch.next,
        view: entry.status === "sending" ? "interrupted" : "unchanged",
        entry: restored,
        storageError: null,
        receipt: null,
      });
    }
    this.emit();
  }
  async keepDraft(draft: Draft | null, id: string, operation: Draft["operation"]) {
    await this.commit((data) => {
      const key = draftKey(id, operation);
      const drafts = without(data.drafts, key);
      if (draft) drafts[key] = draftSchema.parse(draft);
      return { ...data, drafts };
    });
  }
  async save(command: Command, draft: Draft, offline: boolean) {
    const id = command.payload.id;
    this.begin(id);
    const before = this.snapshot(id);
    if (!this.active() || ["storing", "sendingFirst", "sendingRetry"].includes(before.state))
      return;
    if (this.data.entries[id] && before.state !== "storageFailed")
      throw new Error("Review the kept entry first.");
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
      return;
    }
    const stored = transitionWrite("storing", "stored", this.context(entry, { offline }));
    this.show(id, { ...editing(), entry, state: stored.next, view: stored.view });
    if (stored.action === "dispatch" && this.active()) this.send(entry);
  }
  async retry(id: string, offline: boolean, signedIn = true) {
    const before = this.snapshot(id);
    const prior = before.entry;
    if (!prior || !this.active()) return;
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
    const timer = setTimeout(() => {
      void this.answer(key, entry.attempt, { kind: "unknown", cause: "timeout" });
      controller.abort();
    }, this.options.requestTimeoutMs ?? 20000);
    void this.options
      .dispatch(entry.command, controller.signal)
      .catch((): Answer => ({ kind: "unknown", cause: "network" }))
      .then(async (answer) => {
        clearTimeout(timer);
        await this.answer(key, entry.attempt, answer);
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
    const current = this.snapshot(id);
    if (current.state === "storing") {
      if (answer.kind === "receipt" && answer.receipt.id === id) this.deferred.set(key, answer);
      return;
    }
    if (!["sendingFirst", "sendingRetry", "unknown"].includes(current.state)) return;
    const latestEntry = current.entry ?? entry;
    const latest = attempt === latestEntry.attempt;
    if (answer.kind !== "receipt" && !latest) return;
    if (answer.kind === "receipt" && answer.receipt.id !== id) return;
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
  private async repairable(id: string, work: () => Promise<void>, error: "record" | "remove") {
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
    if (!this.active() || this.removed) return;
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
  async removeAll() {
    this.removed = true;
    const work = this.tail.then(async () => {
      await this.options.storage.remove(this.options.scope);
      this.data = emptyPhone();
      this.views.clear();
      this.repairs.clear();
      this.deferred.clear();
      this.emit();
    });
    this.tail = work.catch(() => undefined);
    await this.confirmed(work);
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
