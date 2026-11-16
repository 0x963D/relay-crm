import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { APP_COLUMN_UPDATES, APP_TABLE_PRIVILEGES } from "./app-privileges.ts";

test("the README lists the effective app table and column grants", () => {
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const section = readme.split("### Application grants\n")[1];
  expect(section).toBeDefined();
  const rows = [...(section ?? "").matchAll(/^\s*\| `([^`]+)`\s*\| ([^|]+)\|\s*$/gm)].map(
    ([, name, grants]) => ({
      name,
      privileges: (grants ?? "").replaceAll("`", "").trim().split(/,\s*/),
    }),
  );
  expect(rows.filter((row) => !row.name?.includes("."))).toEqual(
    Object.entries(APP_TABLE_PRIVILEGES).map(([name, privileges]) => ({ name, privileges })),
  );
  expect(rows.filter((row) => row.name?.includes("."))).toEqual(
    APP_COLUMN_UPDATES.map((name) => ({ name, privileges: ["UPDATE"] })),
  );
});
