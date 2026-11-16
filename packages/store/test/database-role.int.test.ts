import { APP_TABLE_PRIVILEGES, APP_COLUMN_UPDATES } from "./app-privileges.ts";
import { expect } from "vitest";
import { test } from "../src/testing/index.ts";
import { randomUUID } from "node:crypto";
import type { Actor } from "@relay/domain";

test("app credentials can aim a future receipt through a lead email but cannot change an existing recipient", async ({
  db,
}) => {
  const actor: Actor = { userId: await db.seedUser("manager"), role: "manager", team: null };
  const agent = await db.seedUser("agent");
  const team = await db.seedTeam("sales");
  const accountId = await db.seedAccount();
  const leadId = await db.seedLead({
    email: "original@example.com",
    lifecycle: {
      state: { status: "won", assignee: { ownerId: agent, teamId: team }, accountId },
      firstAssignedAt: new Date(),
      previousOwnerId: null,
    },
  });
  const complete = async () => {
    const money = { minor: 39500n, currency: "GBP" } as const;
    const { id } = await db.store.createPayment(
      actor,
      { key: randomUUID(), accountId, money, kind: "repeat", mode: "drop" },
      0,
      randomUUID(),
    );
    await db.store.receivePaymentWebhook({
      paymentId: id,
      eventId: randomUUID(),
      payloadHash: "fake",
      observed: { status: "completed", money },
    });
    return id;
  };
  const first = await complete();
  expect(
    await db.rows("UPDATE leads SET email='redirected@example.com' WHERE id=$1 RETURNING email", [
      leadId,
    ]),
  ).toEqual([{ email: "redirected@example.com" }]);
  const second = await complete();
  expect(await db.rows("SELECT payment_id,recipient FROM outbox ORDER BY created_at,id")).toEqual([
    { payment_id: first, recipient: "original@example.com" },
    { payment_id: second, recipient: "redirected@example.com" },
  ]);
  await expect(
    db.rows("UPDATE outbox SET recipient='redirected@example.com' WHERE payment_id=$1", [first]),
  ).rejects.toMatchObject({ code: "42501" });
});

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
  "SELECT * FROM audit_log",
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

test("effective app grants match the explicit table and column lists", async ({ db }) => {
  const tables =
    await db.rows(`SELECT c.relname AS name,array_agg(p.privilege ORDER BY p.privilege) AS privileges
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p(privilege)
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_table_privilege('relay_app',c.oid,p.privilege)
    GROUP BY c.relname ORDER BY c.relname`);
  expect(tables).toEqual(
    Object.entries(APP_TABLE_PRIVILEGES).map(([name, privileges]) => ({ name, privileges })),
  );
  const columns =
    await db.rows(`SELECT c.relname||'.'||a.attname AS name,p.privilege FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS p(privilege)
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      AND NOT has_table_privilege('relay_app',c.oid,p.privilege) AND has_column_privilege('relay_app',c.oid,a.attnum,p.privilege)
    ORDER BY name,p.privilege`);
  expect(columns).toEqual(APP_COLUMN_UPDATES.map((name) => ({ name, privilege: "UPDATE" })));
});
