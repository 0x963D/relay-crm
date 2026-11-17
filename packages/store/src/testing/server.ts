import { randomUUID } from "node:crypto";
import pg from "pg";

export interface TestServer {
  readonly templateName: string;
  newDatabaseName(): string;
  urlFor(database: string): string;
  ownerUrlFor(database: string): string;
  dropDatabase(database: string): Promise<void>;
  dropTestDatabases(runId?: string): Promise<void>;
  /** Runs statements that cannot run inside the database they affect, such as CREATE DATABASE. */
  admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T>;
}

export function testServer(): TestServer {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("Integration tests need DATABASE_URL for the restricted app role.");
  }
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl)
    throw new Error(
      "Integration tests need MIGRATION_DATABASE_URL for database creation and migrations.",
    );
  const base = new URL(databaseUrl);
  const owner = new URL(ownerUrl);
  if (
    base.host !== owner.host ||
    base.pathname !== owner.pathname ||
    base.username === owner.username
  )
    throw new Error(
      "Test app and owner connections must use distinct roles on the same database server.",
    );
  const urlFor = (source: URL, database: string) => {
    const url = new URL(source);
    url.pathname = `/${encodeURIComponent(database)}`;
    return url.toString();
  };
  const baseName = decodeURIComponent(base.pathname.slice(1));

  const admin = async <T>(run: (client: pg.Client) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: ownerUrl });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  };
  const prefix = `${baseName}_test_`;
  const dropDatabase = async (database: string) => {
    if (database !== `${baseName}_template` && !database.startsWith(prefix))
      throw new Error("Refusing to drop a database outside the test namespace.");
    await admin((client) =>
      client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)} WITH (FORCE)`),
    );
  };
  return {
    templateName: `${baseName}_template`,
    newDatabaseName: () =>
      `${prefix}${process.env.RELAY_TEST_RUN ? process.env.RELAY_TEST_RUN + "_" : ""}${randomUUID().replaceAll("-", "")}`,
    urlFor: (database) => urlFor(base, database),
    ownerUrlFor: (database) => urlFor(owner, database),
    admin,
    dropDatabase,
    dropTestDatabases: async (runId) => {
      const names = await admin(
        async (client) =>
          (
            await client.query<{ name: string }>(
              "SELECT datname AS name FROM pg_database WHERE starts_with(datname, $1)",
              [runId ? `${prefix}${runId}_` : prefix],
            )
          ).rows,
      );
      for (const { name } of names) await dropDatabase(name);
    },
  };
}
