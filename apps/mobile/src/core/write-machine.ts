export const writeStates = [
  "editing",
  "storing",
  "storageFailed",
  "sendingFirst",
  "sendingRetry",
  "neverSubmitted",
  "unknown",
  "notSaved",
  "refused",
  "refusedAfterUnknown",
  "saved",
] as const;
export type WriteState = (typeof writeStates)[number];
export const writeEvents = [
  "save",
  "stored",
  "storeFail",
  "ok",
  "accessDenied",
  "leadClosed",
  "invalidTransition",
  "wrongNumber",
  "callbackInPast",
  "callbackNotSet",
  "conflict",
  "other",
  "401",
  "network",
  "timeout",
  "unreadable",
  "background",
  "killed",
  "relaunch",
  "retry",
  "discard",
  "edit",
  "sessionElsewhere",
  "signedIn",
  "signOut",
  "late",
] as const;
export type WriteEvent = (typeof writeEvents)[number];
export type Operation = "attempt" | "note" | "callback" | "close";
export interface WriteContext {
  readonly operation: Operation;
  readonly valid: boolean;
  readonly signedIn: boolean;
  readonly offline: boolean;
  readonly clearCallback: boolean;
  readonly prior: WriteState;
  readonly followsUnknown: boolean;
  readonly landed: boolean;
  readonly landedStatus: "sending" | "neverSubmitted";
  readonly hasContent: boolean;
  readonly copyKept: boolean;
  readonly latest: boolean;
  readonly answer: WriteEvent;
}
export type WriteView =
  | "unchanged"
  | "invalid"
  | "busy"
  | "draftNotKept"
  | "restored"
  | "storageFailed"
  | "offline"
  | "unknown"
  | "interrupted"
  | "refused"
  | "refusedAfterUnknown"
  | "notSaved"
  | "sessionEnded"
  | "signedIn"
  | "retryNotRecorded"
  | "notRecorded"
  | "notRemoved"
  | "saved"
  | "savedCopyHeld"
  | "closingUnavailable"
  | "wrongNumberUnavailable"
  | "past"
  | "noCallback"
  | "conflict"
  | "discardDraft"
  | "discardUnsent"
  | "discardUnknown"
  | "discardNotSaved"
  | "deleteRefused"
  | "deleteUncertain"
  | "signOutDraft"
  | "signOutEntry";
export type WriteAction =
  | "none"
  | "store"
  | "dispatch"
  | "storeDraft"
  | "remove"
  | "confirmRemoval"
  | "recordAnswer"
  | "presentSignIn"
  | "count"
  | "restore"
  | "deferReceipt";
export interface Decision {
  readonly next: WriteState;
  readonly view: WriteView;
  readonly action: WriteAction;
}
type Cell = { readonly impossible: string } | ((context: WriteContext) => Decision);
type Row = Readonly<Record<WriteEvent, Cell>>;
const cannot = (reason: string): Cell => ({ impossible: reason });
const go =
  (next: WriteState, view: WriteView = "unchanged", action: WriteAction = "none"): Cell =>
  () => ({ next, view, action });
function idle(state: WriteState): Row {
  const noAnswer = cannot("No request is awaited in this state.");
  return {
    save: cannot("A kept entry has no Save action."),
    stored: go(state),
    storeFail: go(state, "notRecorded"),
    ok: noAnswer,
    accessDenied: noAnswer,
    leadClosed: noAnswer,
    invalidTransition: noAnswer,
    wrongNumber: noAnswer,
    callbackInPast: noAnswer,
    callbackNotSet: noAnswer,
    conflict: noAnswer,
    other: noAnswer,
    "401": noAnswer,
    network: noAnswer,
    timeout: noAnswer,
    unreadable: noAnswer,
    background: go(state),
    killed: go(state),
    relaunch: go(state, "unchanged", "restore"),
    retry: cannot("This state offers no retry."),
    discard: go(state, "unchanged", "confirmRemoval"),
    edit: cannot("This entry cannot become editable."),
    sessionElsewhere: go(state, "sessionEnded", "presentSignIn"),
    signedIn: go(state),
    signOut: go(state, "signOutEntry", "count"),
    late: cannot("All dispatched attempts have answered, or none was dispatched."),
  };
}
const save: Cell = (c) =>
  !c.signedIn
    ? { next: "editing", view: "sessionEnded", action: "presentSignIn" }
    : c.valid
      ? { next: "storing", view: "busy", action: "store" }
      : { next: "editing", view: "invalid", action: "none" };
function retry(state: WriteState): Cell {
  return (c) =>
    !c.signedIn
      ? { next: state, view: "sessionEnded", action: "presentSignIn" }
      : c.offline
        ? { next: state, view: "unchanged", action: "none" }
        : { next: "storing", view: "busy", action: "store" };
}
function sending(state: "sendingFirst" | "sendingRetry"): Row {
  const after = state === "sendingRetry";
  const refusal = go(
    after ? "refusedAfterUnknown" : "refused",
    after ? "refusedAfterUnknown" : "refused",
    "recordAnswer",
  );
  const correction =
    (view: "closingUnavailable" | "wrongNumberUnavailable"): Cell =>
    (c) =>
      after || c.operation !== "close"
        ? {
            next: after ? "refusedAfterUnknown" : "refused",
            view: after ? "refusedAfterUnknown" : "refused",
            action: "recordAnswer",
          }
        : { next: "editing", view, action: "storeDraft" };
  return {
    ...idle(state),
    save: go(state, "busy"),
    stored: cannot("Storage confirmed before dispatch."),
    storeFail: cannot("No store is pending while awaiting an answer."),
    ok: go("saved", "saved", "remove"),
    accessDenied: refusal,
    leadClosed: refusal,
    invalidTransition: correction("closingUnavailable"),
    wrongNumber: correction("wrongNumberUnavailable"),
    callbackInPast: after ? refusal : go("editing", "past", "storeDraft"),
    callbackNotSet: (c) =>
      c.operation === "callback" && c.clearCallback
        ? { next: "saved", view: "noCallback", action: "remove" }
        : {
            next: after ? "refusedAfterUnknown" : "refused",
            view: after ? "refusedAfterUnknown" : "refused",
            action: "recordAnswer",
          },
    conflict: go(after ? "refusedAfterUnknown" : "refused", "conflict", "recordAnswer"),
    other: refusal,
    "401": go(after ? "unknown" : "notSaved", after ? "sessionEnded" : "notSaved", "recordAnswer"),
    network: go("unknown", "unknown", "recordAnswer"),
    timeout: go("unknown", "unknown", "recordAnswer"),
    unreadable: go("unknown", "unknown", "recordAnswer"),
    relaunch: go("unknown", "interrupted", "restore"),
    retry: cannot("The button is busy."),
    discard: cannot("Dismissal is disabled while sending."),
    edit: cannot("Fields are locked while sending."),
    signOut: cannot("The busy form prevents reaching Account."),
    late: after
      ? (c) =>
          c.answer === "ok"
            ? { next: "saved", view: "saved", action: "remove" }
            : { next: state, view: "unchanged", action: "none" }
      : cannot("Earlier first-send attempts have already answered with 401."),
  };
}
export const writeTable: Readonly<Record<WriteState, Row>> = {
  editing: {
    ...idle("editing"),
    save,
    stored: go("editing"),
    storeFail: go("editing", "draftNotKept"),
    background: (c) => ({
      next: "editing",
      view: "unchanged",
      action: c.hasContent ? "storeDraft" : "none",
    }),
    relaunch: go("editing", "restored", "restore"),
    discard: (c) => ({
      next: "editing",
      view: c.hasContent ? "discardDraft" : "unchanged",
      action: c.hasContent ? "confirmRemoval" : "none",
    }),
    signedIn: go("editing", "signedIn"),
    signOut: go("editing", "signOutDraft", "count"),
    late: go("editing"),
  },
  storing: {
    ...idle("storing"),
    save: go("storing", "busy"),
    stored: (c) =>
      c.offline
        ? { next: "neverSubmitted", view: "offline", action: "none" }
        : {
            next: c.followsUnknown ? "sendingRetry" : "sendingFirst",
            view: "busy",
            action: "dispatch",
          },
    storeFail: (c) =>
      c.prior === "editing" || c.prior === "storageFailed"
        ? { next: "storageFailed", view: "storageFailed", action: "none" }
        : { next: c.prior, view: "retryNotRecorded", action: "none" },
    relaunch: (c) => ({
      next: c.landed
        ? c.landedStatus === "neverSubmitted"
          ? "neverSubmitted"
          : "unknown"
        : c.prior === "storageFailed"
          ? "editing"
          : c.prior,
      view: c.landed
        ? c.landedStatus === "neverSubmitted"
          ? "offline"
          : "interrupted"
        : "restored",
      action: "restore",
    }),
    discard: cannot("Dismissal is disabled while storing."),
    edit: cannot("Fields are locked while storing."),
    signOut: cannot("The busy form prevents reaching Account."),
    late: (c) => ({
      next: "storing",
      view: "unchanged",
      action: c.answer === "ok" ? "deferReceipt" : "none",
    }),
  },
  storageFailed: {
    ...idle("storageFailed"),
    save: cannot("The action is Retry."),
    stored: go("storageFailed"),
    storeFail: go("storageFailed"),
    background: go("storageFailed", "unchanged", "storeDraft"),
    relaunch: go("editing", "restored", "restore"),
    retry: save,
    discard: go("storageFailed", "discardDraft", "confirmRemoval"),
    signOut: cannot("Leaving this draft requires the discard alert."),
    late: go("storageFailed"),
  },
  sendingFirst: sending("sendingFirst"),
  sendingRetry: sending("sendingRetry"),
  neverSubmitted: {
    ...idle("neverSubmitted"),
    stored: cannot("Its only write already confirmed."),
    storeFail: cannot("No write is pending."),
    retry: retry("neverSubmitted"),
    edit: go("editing", "unchanged", "storeDraft"),
    discard: go("neverSubmitted", "discardUnsent", "confirmRemoval"),
  },
  unknown: {
    ...idle("unknown"),
    retry: retry("unknown"),
    discard: go("unknown", "discardUnknown", "confirmRemoval"),
    late: (c) =>
      c.answer === "ok"
        ? { next: "saved", view: "saved", action: "remove" }
        : c.latest && !["network", "timeout", "unreadable"].includes(c.answer)
          ? transitionWrite(c.followsUnknown ? "sendingRetry" : "sendingFirst", c.answer, c)
          : { next: "unknown", view: "unchanged", action: "none" },
  },
  notSaved: {
    ...idle("notSaved"),
    sessionElsewhere: go("notSaved"),
    retry: retry("notSaved"),
    edit: go("editing", "unchanged", "storeDraft"),
    discard: go("notSaved", "discardNotSaved", "confirmRemoval"),
  },
  refused: { ...idle("refused"), discard: go("refused", "deleteRefused", "confirmRemoval") },
  refusedAfterUnknown: {
    ...idle("refusedAfterUnknown"),
    discard: go("refusedAfterUnknown", "deleteUncertain", "confirmRemoval"),
    late: go("refusedAfterUnknown"),
  },
  saved: {
    ...idle("saved"),
    save: cannot("The form has closed."),
    storeFail: go("saved", "savedCopyHeld"),
    relaunch: (c) => ({
      next: c.copyKept ? "unknown" : "saved",
      view: c.copyKept ? "interrupted" : "unchanged",
      action: "restore",
    }),
    discard: cannot("The entry is already saved."),
    late: go("saved"),
    signOut: go("saved"),
  },
};
export function transitionWrite(
  state: WriteState,
  event: WriteEvent,
  context: WriteContext,
): Decision {
  const cell = writeTable[state][event];
  if ("impossible" in cell) throw new Error(`${state}/${event}: ${cell.impossible}`);
  return cell(context);
}
