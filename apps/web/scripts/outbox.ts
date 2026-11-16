import { openStore } from "@relay/store";
import { readEnv } from "../src/server/env.ts";
import { createReceiptMailer } from "../src/server/mailer.ts";
const env = readEnv();
if (env.auth?.delivery.kind !== "smtp") throw new Error("Receipt delivery needs SMTP.");
const store = openStore({ connectionString: env.databaseUrl, receipts: env.receipts });
try {
  process.stdout.write(
    JSON.stringify(await store.runOutbox(createReceiptMailer(env.auth.delivery))) + "\n",
  );
} finally {
  await store.close();
}
