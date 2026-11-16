import { expect } from "vitest";
import { test } from "../src/testing/index.ts";

test("the app connection has no ownership or privileged role attributes", async ({ db }) => {
  expect(
    await db.rows(
      "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname=current_user",
    ),
  ).toEqual([
    {
      name: "relay_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
    },
  ]);
  expect(
    await db.rows(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tableowner=current_user",
    ),
  ).toEqual([]);
});

test.for([
  "TRUNCATE ledger_lines",
  "TRUNCATE ledger_transactions CASCADE",
  "TRUNCATE ledger_accounts CASCADE",
  "ALTER TABLE ledger_lines DISABLE TRIGGER ledger_lines_append_only",
  "ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_transactions_append_only",
  "ALTER TABLE ledger_accounts DISABLE TRIGGER ledger_accounts_append_only",
  "SET session_replication_role = replica",
  "UPDATE ledger_lines SET amount=amount+1",
  "DELETE FROM ledger_lines",
  "SET ROLE relay_owner",
])("the app role refuses %s", async (sql, { db }) => {
  await db.rows("BEGIN");
  try {
    await expect(db.rows(sql)).rejects.toMatchObject({ code: "42501" });
  } finally {
    await db.rows("ROLLBACK");
  }
});
