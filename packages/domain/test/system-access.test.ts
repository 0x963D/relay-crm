import { expect, it } from "vitest";
import { recordScope, SYSTEM_ACTORS } from "../src/index.ts";

it.each(SYSTEM_ACTORS)("limits %s to the named job", (name) => {
  for (const record of ["lead", "account"] as const) {
    for (const access of ["read", "edit", "assign", "identity", "reopen"] as const) {
      expect(recordScope({ kind: "system", name }, record, access)).toEqual({
        kind:
          name === "intake" && record === "lead" && (access === "identity" || access === "reopen")
            ? "all"
            : "none",
      });
    }
  }
});
