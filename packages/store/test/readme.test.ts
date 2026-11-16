import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { APP_COLUMN_UPDATES, APP_TABLE_PRIVILEGES } from "./app-privileges.ts";

test("the README lists the effective app table and column grants", () => {
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const tables = [
    ...readme.matchAll(
      /^\s*\| `([a-z_]+)`\s*\| ((?:`(?:DELETE|INSERT|SELECT|UPDATE)`[, ]*)+)\s*\|\s*$/gm,
    ),
  ].map(([, name, grants]) => [
    name,
    [...(grants ?? "").matchAll(/`([A-Z]+)`/g)].map((match) => match[1]),
  ]);
  expect(tables).toEqual(Object.entries(APP_TABLE_PRIVILEGES));
  const columns = [...readme.matchAll(/^\s*\| `([a-z_]+\.[a-z_]+)`\s*\| `UPDATE`\s*\|\s*$/gm)].map(
    ([, name]) => name,
  );
  expect(columns).toEqual(APP_COLUMN_UPDATES);
});
