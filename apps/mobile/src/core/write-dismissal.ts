import type { WriteState } from "./write-machine.ts";

type Dismissal = "close" | "discardDraft" | "blocked" | "withdrawConfirmation";
interface DismissalRule {
  readonly dismiss: "content" | "close" | "blocked";
  readonly background: "keepDraft" | "continue" | "keep";
}
const rules: Readonly<Record<WriteState, DismissalRule>> = {
  editing: { dismiss: "content", background: "keepDraft" },
  storageFailed: { dismiss: "content", background: "keepDraft" },
  storing: { dismiss: "blocked", background: "continue" },
  sendingFirst: { dismiss: "blocked", background: "continue" },
  sendingRetry: { dismiss: "blocked", background: "continue" },
  neverSubmitted: { dismiss: "close", background: "keep" },
  unknown: { dismiss: "close", background: "keep" },
  notSaved: { dismiss: "close", background: "keep" },
  refused: { dismiss: "close", background: "keep" },
  refusedAfterUnknown: { dismiss: "close", background: "keep" },
  saved: { dismiss: "close", background: "keep" },
};
export function dismissWrite(
  state: WriteState,
  hasContent: boolean,
  confirmation: boolean,
): Dismissal {
  if (confirmation) return "withdrawConfirmation";
  const rule = rules[state].dismiss;
  return rule === "content"
    ? hasContent || state === "storageFailed"
      ? "discardDraft"
      : "close"
    : rule;
}
export const backgroundWrite = (state: WriteState) => rules[state].background;
