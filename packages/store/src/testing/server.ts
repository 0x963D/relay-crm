import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";

export interface TestServer {
  readonly templateName: string;
  newDatabaseName(): string;
  urlFor(database: string): string;
  ownerUrlFor(database: string): string;
  dropDatabase(database: string): Promise<void>;
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
  return {
    templateName: `${baseName}_template`,
    newDatabaseName: () => `${baseName}_test_${randomUUID().replaceAll("-", "")}`,
    urlFor: (database) => urlFor(base, database),
    ownerUrlFor: (database) => urlFor(owner, database),
    admin,
    dropDatabase: async (database) => {
      await admin(async (client) => {
        for (let attempt = 0; ; attempt += 1) {
          try {
            await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(database)}`);
            return;
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "55006" ||
              attempt >= 100
            )
              throw error;
            await sleep(20);
          }
        }
      });
    },
  };
}
