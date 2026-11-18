import type { WriteState } from "./write-machine.ts";
import type { Lead } from "./api-types.ts";
import { clock, contextualDate } from "./dates.ts";
import type { Entry, WriteSnapshot } from "./write-model.ts";
import type { IconName } from "./icons.ts";

interface BandWords {
  readonly title: string;
  readonly text: string;
  readonly kind: "wait" | "refused" | "info" | "done";
  readonly icon: IconName;
}
const uncertainty = "It may or may not have saved. Trying again is safe: it never saves twice.";
export function writeBand(
  snapshot: WriteSnapshot,
  signedIn: boolean,
  lead?: Lead,
  zone?: string,
  now = new Date(),
): BandWords | null {
  const entry = snapshot.entry;
  let words: BandWords | null = null;
  if (snapshot.state === "storageFailed")
    words = {
      title: "Not kept on this phone",
      text: "Nothing was sent. What you typed is only on this screen.",
      kind: "wait",
      icon: "help",
    };
  else if (snapshot.state === "neverSubmitted")
    words = {
      title: "Not sent. You are offline.",
      text: "It has not left this phone, where it is kept for you.",
      kind: "wait",
      icon: "offline",
    };
  else if (snapshot.state === "notSaved")
    words = {
      title: "Not saved. Your session had ended.",
      text: signedIn
        ? "It is kept on this phone. You can send it now."
        : "It is kept on this phone and can be sent once you are back in.",
      kind: "wait",
      icon: "lock",
    };
  else if (snapshot.state === "unknown")
    words = {
      title:
        entry?.unknownCause === "interrupted"
          ? "The app closed while this was sending"
          : entry?.unknownCause === "server"
            ? "The server could not finish this"
            : entry?.unknownCause === "unreadable"
              ? "The answer could not be read"
              : entry?.unknownCause === "session" && !signedIn
                ? "Your session ended"
                : "No answer came back",
      text:
        entry?.unknownCause === "session" && !signedIn
          ? "This entry still may or may not have saved. Trying again needs a new session."
          : uncertainty,
      kind: "wait",
      icon: entry?.unknownCause === "session" && !signedIn ? "lock" : "help",
    };
  else if ((snapshot.state === "refused" || snapshot.state === "refusedAfterUnknown") && entry) {
    const reason = entry.refusal;
    const after = snapshot.state === "refusedAfterUnknown";
    const prefix = after ? "Refused on retry." : "Not saved.";
    if (reason === "idempotencyConflict")
      words = {
        title: "This copy was not taken",
        text: "Its reference was already used for a different request, possibly about someone else.",
        kind: "refused",
        icon: "error",
      };
    else if (reason === "accessDenied")
      words = {
        title: `${prefix} This lead is no longer yours.`,
        text: after
          ? "The first try may have saved before that. Ask your manager to check its history."
          : "Its owner or your access changed. Ask your manager who holds it now.",
        kind: "refused",
        icon: "error",
      };
    else if (reason === "leadClosed") {
      const closure = lead?.timeline.find((item) => item.kind === "closure");
      const status = lead?.lifecycle.state.status;
      const time = closure && zone ? contextualDate(closure.at, now, zone, "checked") : "";
      words = {
        title: `${prefix} This lead is closed.`,
        text: after
          ? "The first try may have saved before that. Check the timeline."
          : closure
            ? `${closure.actor ? `${closure.actor.name} marked it` : "It was marked"} ${status ?? "closed"}${time ? ` at ${time}` : ""}.`
            : "Its history shows who did that.",
        kind: "refused",
        icon: "error",
      };
    } else
      words = {
        title: after
          ? reason === "callbackInPast"
            ? "Refused on retry. The callback time has passed."
            : "Refused on retry."
          : "Not saved. The server did not accept this.",
        text: after
          ? "The first try may have saved before that. Check the timeline before logging it again."
          : "Nothing changed there.",
        kind: "refused",
        icon: "error",
      };
  } else if (snapshot.state === "editing" && snapshot.view === "closingUnavailable")
    words = {
      title: "Won and lost are not open yet",
      text: "They need an attempt or a callback on this lead first.",
      kind: "info",
      icon: "help",
    };
  if (snapshot.storageError) {
    const text =
      snapshot.storageError === "retry"
        ? "This phone could not record the retry, so nothing was sent."
        : snapshot.storageError === "remove"
          ? snapshot.state === "saved"
            ? "This phone could not clear its copy."
            : "This phone could not remove it."
          : "This phone could not record that.";
    words = words
      ? { ...words, text: `${words.text} ${text}` }
      : {
          title: snapshot.state === "saved" ? "Saved" : "Kept on this phone",
          text,
          kind: snapshot.state === "saved" ? "done" : "wait",
          icon: snapshot.state === "saved" ? "check" : "help",
        };
  }
  return words;
}
export const operationName = (entry: Entry) =>
  entry.command.operation === "close" ? "closing" : entry.command.operation;
export function reviewTitle(entry: Entry, snapshot: WriteSnapshot, zone?: string) {
  const time = zone ? ` ${clock(new Date(entry.savedAt), zone)}` : "";
  const fact =
    snapshot.state === "saved"
      ? "was saved"
      : entry.refusal === "idempotencyConflict"
        ? "was not taken"
        : snapshot.state === "neverSubmitted"
          ? "has not been sent"
          : snapshot.state === "notSaved"
            ? "was not saved"
            : snapshot.state === "refusedAfterUnknown"
              ? "was refused on retry"
              : snapshot.state === "refused"
                ? "was refused"
                : "may not have saved";
  return `Your${time} ${operationName(entry)} ${fact}`;
}
export function entryCaption(snapshot: WriteSnapshot) {
  return snapshot.entry?.refusal === "idempotencyConflict"
    ? "Your copy, not sent again"
    : snapshot.state === "unknown" || snapshot.state === "refusedAfterUnknown"
      ? "May or may not be on the timeline"
      : snapshot.state === "refused"
        ? "Your entry, not on the timeline"
        : "Not on the timeline";
}
export function removalWords(snapshot: WriteSnapshot, hasNote: boolean) {
  const uncertain =
    snapshot.state === "unknown" ||
    snapshot.state === "refusedAfterUnknown" ||
    snapshot.entry?.refusal === "idempotencyConflict";
  const refused = snapshot.state === "refused" || snapshot.state === "refusedAfterUnknown";
  return {
    title: refused
      ? "Delete this copy?"
      : `Discard this ${snapshot.entry ? operationName(snapshot.entry) : "attempt"}?`,
    text: refused
      ? `${uncertain ? "The server may already hold it." : "It was not saved."}${hasNote ? " Your note will be gone from this phone." : ""}`
      : uncertain
        ? "The server may already have saved it. Discarding removes only the copy on this phone."
        : snapshot.state === "neverSubmitted"
          ? "It never left this phone, so nothing is lost on the server."
          : "It was not saved, so nothing is lost on the server.",
    action: refused ? "Delete" : "Discard",
  };
}
export function storedCounts(counts: { entries: number; drafts: number } | null) {
  if (!counts) return "An unknown number of kept items";
  return [
    counts.entries
      ? `${String(counts.entries)} unresolved ${counts.entries === 1 ? "entry" : "entries"}`
      : "",
    counts.drafts ? `${String(counts.drafts)} ${counts.drafts === 1 ? "draft" : "drafts"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
}
export function successWords(entry: Entry, zone?: string, now = new Date()) {
  const command = entry.command;
  switch (command.operation) {
    case "note":
      return { title: "Note saved", text: "" };
    case "callback":
      return command.payload.change.kind === "clear"
        ? { title: "Callback cleared", text: "The lead stays in your queue." }
        : {
            title: "Callback saved",
            text: zone
              ? `Set for ${contextualDate(new Date(command.payload.change.at), now, zone, "callback")}.`
              : "",
          };
    case "close":
      return {
        title: `Closed as ${command.payload.closing.kind}`,
        text: "It has left your queue.",
      };
    case "attempt": {
      const spoke = command.payload.outcome === "spokeToThem";
      const callback = command.payload.callback;
      return {
        title: "Attempt saved",
        text:
          callback?.kind === "set"
            ? `Logged as ${spoke ? "spoke to them" : "no answer"}${zone ? `, with a callback for ${contextualDate(new Date(callback.at), now, zone, "callback")}` : ", with a callback"}.`
            : spoke
              ? "Logged as spoke to them."
              : "Logged as no answer, which does not count as contact.",
      };
    }
  }
}

export function entriesFact(states: readonly (WriteState | undefined)[]) {
  const uncertain = () =>
    states.length > 1 ? "Some may not have saved." : "It may not have saved.";
  if (
    !states.length ||
    states.some(
      (state) =>
        state === undefined || !["saved", "refused", "notSaved", "neverSubmitted"].includes(state),
    )
  )
    return uncertain();
  if (states.includes("refused")) return "It was refused.";
  if (states.includes("notSaved")) return "It was not saved.";
  if (states.includes("neverSubmitted")) return "It has not been sent.";
  return "It was saved.";
}
