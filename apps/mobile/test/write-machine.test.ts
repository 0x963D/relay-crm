import { expect, it } from "vitest";
import {
  transitionWrite,
  writeEvents,
  writeStates,
  writeTable,
} from "../src/core/write-machine.ts";
import type { Decision, WriteContext, WriteState } from "../src/core/write-machine.ts";

const context: WriteContext = {
  operation: "attempt",
  valid: true,
  signedIn: true,
  offline: false,
  clearCallback: false,
  prior: "editing",
  followsUnknown: false,
  landed: true,
  hasContent: true,
  copyKept: false,
  latest: true,
  answer: "ok",
};
const unavailableAnswers = Array.from({ length: 13 }, () => "x").join(" ");
const expected: Record<WriteState, string> = {
  editing: `S = D ${unavailableAnswers} BG = R x DD x SE SI SO =`,
  storing: `B T F ${unavailableAnswers} = = L x x x SE = x DEFER`,
  storageFailed: `x = = ${unavailableAnswers} BG = R S DD x SE = x =`,
  sendingFirst:
    "B x x SAV REF REF REF REF PAST REF CON REF NS UN UN UN = = INTERRUPT x x x SE = x x",
  sendingRetry: "B x x SAV RA RA RA RA RA RA CONA RA US UN UN UN = = INTERRUPT x x x SE = x SAV",
  neverSubmitted: `x x x ${unavailableAnswers} = = REST RET DU EDIT SE = SO x`,
  unknown: `x = NR ${unavailableAnswers} = = REST RET DX x SE = SO SAV`,
  notSaved: `x = NR ${unavailableAnswers} = = REST RET DN EDIT SE = SO x`,
  refused: `x = NR ${unavailableAnswers} = = REST x DR x SE = SO x`,
  refusedAfterUnknown: `x = NR ${unavailableAnswers} = = REST x DA x SE = SO =`,
  saved: `x = COPY ${unavailableAnswers} = = REST x x x SE = = =`,
};
function outcome(token: string, state: WriteState): Decision {
  const decision = (
    next: WriteState,
    view: Decision["view"] = "unchanged",
    action: Decision["action"] = "none",
  ): Decision => ({ next, view, action });
  switch (token) {
    case "=":
      return decision(state);
    case "S":
      return decision("storing", "busy", "store");
    case "D":
      return decision(state, "draftNotKept");
    case "BG":
      return decision(state, "unchanged", "storeDraft");
    case "R":
      return decision("editing", "restored", "restore");
    case "DD":
      return decision(state, "discardDraft", "confirmRemoval");
    case "SE":
      return decision(state, "sessionEnded", "presentSignIn");
    case "SI":
      return decision(state, "signedIn");
    case "SO":
      return decision(state, state === "editing" ? "signOutDraft" : "signOutEntry", "count");
    case "B":
      return decision(state, "busy");
    case "T":
      return decision("sendingFirst", "busy", "dispatch");
    case "F":
      return decision("storageFailed", "storageFailed");
    case "L":
    case "INTERRUPT":
      return decision("unknown", "interrupted", "restore");
    case "DEFER":
      return decision(state, "unchanged", "deferReceipt");
    case "SAV":
      return decision("saved", "saved", "remove");
    case "REF":
      return decision("refused", "refused", "recordAnswer");
    case "RA":
      return decision("refusedAfterUnknown", "refusedAfterUnknown", "recordAnswer");
    case "PAST":
      return decision("editing", "past", "storeDraft");
    case "CON":
    case "CONA":
      return decision(
        token === "CON" ? "refused" : "refusedAfterUnknown",
        "conflict",
        "recordAnswer",
      );
    case "NS":
      return decision("notSaved", "notSaved", "recordAnswer");
    case "UN":
      return decision("unknown", "unknown", "recordAnswer");
    case "US":
      return decision("unknown", "sessionEnded", "recordAnswer");
    case "REST":
      return decision(state, "unchanged", "restore");
    case "RET":
      return decision("storing", "busy", "store");
    case "EDIT":
      return decision("editing", "unchanged", "storeDraft");
    case "NR":
      return decision(state, "notRecorded");
    case "COPY":
      return decision("saved", "savedCopyHeld");
    case "DU":
    case "DX":
    case "DN":
    case "DR":
    case "DA":
      return decision(
        state,
        token === "DU"
          ? "discardUnsent"
          : token === "DX"
            ? "discardUnknown"
            : token === "DN"
              ? "discardNotSaved"
              : token === "DR"
                ? "deleteRefused"
                : "deleteUncertain",
        "confirmRemoval",
      );
    default:
      throw new Error(`Unknown fixture ${token}`);
  }
}
for (const state of writeStates) {
  const cells = expected[state].split(" ");
  it(`${state} has exactly 26 specified cells`, () => {
    expect(cells).toHaveLength(26);
  });
  for (const [index, event] of writeEvents.entries()) {
    it(`${state} × ${event}`, () => {
      const token = cells[index];
      if (!token) throw new Error("Missing specified cell.");
      if (token === "x") {
        expect(writeTable[state][event]).toHaveProperty("impossible");
        expect(() => transitionWrite(state, event, context)).toThrow(`${state}/${event}`);
      } else expect(transitionWrite(state, event, context)).toEqual(outcome(token, state));
    });
  }
}
it("accounts for all 286 cells and all 158 impossible cells", () => {
  expect(Object.values(writeTable).flatMap(Object.values)).toHaveLength(286);
  expect(
    Object.values(writeTable)
      .flatMap(Object.values)
      .filter((cell) => "impossible" in cell),
  ).toHaveLength(158);
});
it("does not store or ask to discard an empty draft and recovers a saved copy conservatively", () => {
  expect(transitionWrite("editing", "background", { ...context, hasContent: false }).action).toBe(
    "none",
  );
  expect(transitionWrite("editing", "discard", { ...context, hasContent: false })).toMatchObject({
    view: "unchanged",
    action: "none",
  });
  expect(transitionWrite("saved", "relaunch", { ...context, copyKept: true })).toMatchObject({
    next: "unknown",
    view: "interrupted",
  });
});
it.each(["invalidTransition", "wrongNumber"] as const)(
  "returns a first closing to its draft for %s",
  (event) => {
    expect(
      transitionWrite("sendingFirst", event, { ...context, operation: "close" }),
    ).toMatchObject({ next: "editing", action: "storeDraft" });
  },
);
it.each(["sendingFirst", "sendingRetry"] as const)(
  "treats a clear with no callback as finished from %s",
  (state) => {
    expect(
      transitionWrite(state, "callbackNotSet", {
        ...context,
        operation: "callback",
        clearCallback: true,
      }),
    ).toEqual({ next: "saved", view: "noCallback", action: "remove" });
  },
);
it("does not dispatch offline, retry offline or save invalid input", () => {
  expect(transitionWrite("storing", "stored", { ...context, offline: true })).toMatchObject({
    next: "neverSubmitted",
    action: "none",
  });
  expect(transitionWrite("unknown", "retry", { ...context, offline: true })).toMatchObject({
    next: "unknown",
    action: "none",
  });
  expect(transitionWrite("editing", "save", { ...context, valid: false })).toMatchObject({
    next: "editing",
    view: "invalid",
  });
  expect(transitionWrite("editing", "save", { ...context, signedIn: false })).toMatchObject({
    action: "presentSignIn",
  });
});
it("preserves the previous entry on a failed retry store or interrupted store", () => {
  expect(transitionWrite("storing", "storeFail", { ...context, prior: "unknown" })).toEqual({
    next: "unknown",
    view: "retryNotRecorded",
    action: "none",
  });
  expect(
    transitionWrite("storing", "relaunch", { ...context, landed: false, prior: "neverSubmitted" }),
  ).toMatchObject({ next: "neverSubmitted" });
  expect(transitionWrite("storing", "stored", { ...context, followsUnknown: true })).toMatchObject({
    next: "sendingRetry",
  });
});
it("uses the sending row for latest late refusals and ignores late transport failures", () => {
  expect(
    transitionWrite("unknown", "late", {
      ...context,
      answer: "accessDenied",
      followsUnknown: true,
    }),
  ).toMatchObject({ next: "refusedAfterUnknown" });
  expect(
    transitionWrite("unknown", "late", { ...context, answer: "accessDenied", latest: false }),
  ).toMatchObject({ next: "unknown", action: "none" });
  expect(transitionWrite("unknown", "late", { ...context, answer: "network" })).toMatchObject({
    next: "unknown",
    action: "none",
  });
});
