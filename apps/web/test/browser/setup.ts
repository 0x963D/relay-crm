import { mkdir, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDatabase, prepareTestServer } from "@relay/store/testing/database";
import { seedDemo } from "@relay/store/demo";
import { openSmtpInbox } from "../support/smtp.ts";
import { serve } from "../support/production-server.ts";
import { browserDirectory, stateFile } from "./paths.ts";
export default async function setup() {
  await mkdir(browserDirectory, { recursive: true });
  await prepareTestServer();
  const { db, dispose } = await createTestDatabase();
  const inboxFile = join(browserDirectory, "inbox.jsonl");
  await writeFile(inboxFile, "");
  const inbox = await openSmtpInbox((message) => {
    appendFileSync(inboxFile, JSON.stringify(message) + "\n");
    return "sent";
  });
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  let standard: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await seedDemo({
      ownerUrl: db.ownerConnectionString,
      appUrl: db.connectionString,
      today: new Date(),
      timeZone: "UTC",
      deliver: () => Promise.resolve({ state: "sent" }),
    });
    server = await serve(
      (origin) => ({
        AUTH_URL: origin,
        AUTH_SECRET: "fake-browser-test-0123456789-abcdefghijklmnopqrstuvwxyz",
        SMTP_URL: inbox.url,
        SMTP_FROM: "relay@tidewell.example",
        RELAY_DEMO: "1",
        RELAY_TIME_ZONE: "UTC",
        RELAY_TRUSTED_PROXY_COUNT: "1",
      }),
      db.connectionString,
    );
    standard = await serve(
      (origin) => ({
        AUTH_URL: origin,
        AUTH_SECRET: "fake-browser-test-0123456789-abcdefghijklmnopqrstuvwxyz",
        SMTP_URL: inbox.url,
        SMTP_FROM: "relay@tidewell.example",
      }),
      db.connectionString,
    );
    await writeFile(
      stateFile,
      JSON.stringify({ url: server.url(""), signInUrl: standard.url(""), inbox: inboxFile }),
    );
  } catch (error) {
    await server?.stop();
    await standard?.stop();
    await inbox.close();
    await dispose();
    throw error;
  }
  return async () => {
    await server.stop();
    await standard.stop();
    await writeFile(join(browserDirectory, "server.log"), server.output());
    await inbox.close();
    await dispose();
  };
}
