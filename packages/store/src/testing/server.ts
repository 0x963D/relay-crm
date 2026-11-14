import { randomUUID } from "node:crypto";
import pg from "pg";

export interface TestServer {
  readonly templateName: string;
  newDatabaseName(): string;
  urlFor(database: string): string;
  /** Runs statements that cannot run inside the database they affect, such as CREATE DATABASE. */
  admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T>;
}

export function testServer(): TestServer {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(
      "Integration tests need DATABASE_URL to name a PostgreSQL server they may create databases on.",
    );
  }
  const base = new URL(databaseUrl);
  const baseName = decodeURIComponent(base.pathname.slice(1));

  return {
    templateName: `${baseName}_template`,
    newDatabaseName: () => `${baseName}_test_${randomUUID().replaceAll("-", "")}`,
    urlFor: (database) => {
      const url = new URL(base);
      url.pathname = `/${encodeURIComponent(database)}`;
      return url.toString();
    },
    admin: async (run) => {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        return await run(client);
      } finally {
        await client.end();
      }
    },
  };
}
