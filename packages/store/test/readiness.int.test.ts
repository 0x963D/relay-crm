import { expect } from "vitest";
import { test } from "@relay/store/testing";
import { REQUIRED_MIGRATION } from "../src/demo-state.ts";

test("readiness requires a finished migration and refuses unfinished work without exposing history", async ({
  db,
}) => {
  expect(await db.store.databaseReady()).toBe(true);
  await expect(db.rows("SELECT * FROM _prisma_migrations")).rejects.toMatchObject({
    code: "42501",
  });
  await db.ownerRows("UPDATE _prisma_migrations SET finished_at=NULL WHERE migration_name=$1", [
    REQUIRED_MIGRATION,
  ]);
  expect(await db.store.databaseReady()).toBe(false);
  await db.ownerRows("UPDATE _prisma_migrations SET finished_at=now() WHERE migration_name=$1", [
    REQUIRED_MIGRATION,
  ]);
  await db.ownerRows(
    "INSERT INTO _prisma_migrations(id,checksum,migration_name,started_at) VALUES ('unfinished','test','future',now())",
  );
  expect(await db.store.databaseReady()).toBe(false);
  await db.ownerRows("UPDATE _prisma_migrations SET rolled_back_at=now() WHERE id='unfinished'");
  expect(await db.store.databaseReady()).toBe(true);
  await db.ownerRows("DELETE FROM _prisma_migrations WHERE migration_name=$1", [
    REQUIRED_MIGRATION,
  ]);
  expect(await db.store.databaseReady()).toBe(false);
});
