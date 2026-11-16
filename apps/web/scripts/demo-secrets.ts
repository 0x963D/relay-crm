import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const directory = "/run/relay-secrets";
await mkdir(directory, { recursive: true, mode: 0o755 });
async function secret(name: string, postgres = false) {
  const path = `${directory}/${name}`;
  try {
    await writeFile(path, randomBytes(32).toString("base64url"), {
      flag: "wx",
      mode: postgres ? 0o644 : 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  return (await readFile(path, "utf8")).trim();
}
await secret("postgres-password", true);
const ownerPassword = await secret("owner-password", true);
const appPassword = await secret("app-password", true);
const auth = await secret("auth-secret");
const webhook = await secret("webhook-secret");
const reconcile = await secret("reconcile-secret");
const outbox = await secret("outbox-secret");
const reset = await secret("reset-secret");
const ownerUrl = `postgresql://relay_owner:${ownerPassword}@db:5432/relay`;
await writeFile(`${directory}/owner.json`, JSON.stringify({ ownerUrl }), { mode: 0o600 });
await writeFile(
  `${directory}/jobs.json`,
  JSON.stringify({ origin: "http://app:3107", reconcile, outbox, reset }),
  { mode: 0o600 },
);
await writeFile(
  `${directory}/app.json`,
  JSON.stringify({
    DATABASE_URL: `postgresql://relay_app:${appPassword}@db:5432/relay`,
    AUTH_SECRET: auth,
    AUTH_URL: "http://127.0.0.1:3107",
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "3107",
    RELAY_TRUSTED_PROXY_COUNT: "0",
    RELAY_TIME_ZONE: "UTC",
    RELAY_DEMO: "1",
    RELAY_SANDBOX: "1",
    RELAY_PUBLIC_FORM: "1",
    RELAY_SANDBOX_URL: "http://127.0.0.1:3107",
    RELAY_PAYMENT_WEBHOOK_SECRET: webhook,
    RELAY_RECONCILE_SECRET: reconcile,
    RELAY_OUTBOX_SECRET: outbox,
    RELAY_DEMO_RESET_SECRET: reset,
    RELAY_DEMO_OWNER_FILE: `${directory}/owner.json`,
    RELAY_RECONCILE_FIRST_MS: "0",
    RELAY_RECONCILE_INTERVAL_MS: "60000",
    RELAY_SANDBOX_LATE_MS: "60000",
    SMTP_URL: "smtp://mail:1025",
    SMTP_FROM: "receipts@tidewell.example",
  }),
  { mode: 0o600 },
);
process.stdout.write("Local demo configuration is ready.\n");
