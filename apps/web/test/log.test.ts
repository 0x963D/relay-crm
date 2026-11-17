import { expect, test } from "vitest";
import { errorIdentity } from "../src/server/log.ts";

test("error identity uses the stable error name without its message", () => {
  class _ extends Error {
    override readonly name = "StableFailure";
  }
  expect(errorIdentity(new _("private request data"))).toEqual({
    class: "StableFailure",
    code: null,
  });
  expect(errorIdentity(Object.assign(new Error("private"), { code: "P2002" }))).toEqual({
    class: "Error",
    code: "P2002",
  });
});
