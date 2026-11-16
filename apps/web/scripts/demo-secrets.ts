import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, chown } from "node:fs/promises";

const directory = "/run/relay-secrets";
const timeZone = process.argv[2] ?? "UTC";
const port = Number(process.argv[3] ?? "3107");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid demo HTTP port.");
const origin = `http://127.0.0.1:${String(port)}`;
new Intl.DateTimeFormat("en", { timeZone }).format();
for (const [name, uid] of [
  ["db", 999],
  ["app", 1000],
  ["reset", 1000],
  ["jobs", 1000],
] as const) {
  await mkdir(`${directory}/${name}`, { recursive: true, mode: 0o700 });
  await chmod(`${directory}/${name}`, 0o700);
  await chown(`${directory}/${name}`, uid, uid);
}
async function secret(name: string) {
  const path = `${directory}/db/${name}`;
  try {
    await writeFile(path, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  await chmod(path, 0o600);
  await chown(path, 999, 999);
  return (await readFile(path, "utf8")).trim();
}
await secret("postgres-password");
const ownerPassword = await secret("owner-password");
const appPassword = await secret("app-password");
const previous: unknown = await readFile(`${directory}/app/config.json`, "utf8")
  .then((text): unknown => JSON.parse(text))
  .catch((error: unknown) => {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    return null;
  });
function key(name: string) {
  if (previous === null) return randomBytes(32).toString("base64url");
  const value: unknown = typeof previous === "object" ? Reflect.get(previous, name) : null;
  if (typeof value !== "string" || value.length < 32)
    throw new Error("Invalid persisted demo configuration.");
  return value;
}
async function config(name: string, value: object) {
  const path = `${directory}/${name}/config.json`;
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
  await chown(path, 1000, 1000);
}
const ownerUrl = `postgresql://relay_owner:${ownerPassword}@db:5432/relay`;
const appUrl = `postgresql://relay_app:${appPassword}@db:5432/relay`;
const reconcile = key("RELAY_RECONCILE_SECRET");
const outbox = key("RELAY_OUTBOX_SECRET");
const common = {
  DATABASE_URL: appUrl,
  RELAY_DEMO: "1",
  RELAY_TIME_ZONE: timeZone,
  SMTP_URL: "smtp://mail:1025",
  SMTP_FROM: "receipts@tidewell.example",
};
await config("reset", { ...common, MIGRATION_DATABASE_URL: ownerUrl });
await config("jobs", { origin: "http://app:3107", reconcile, outbox });
await config("app", {
  ...common,
  AUTH_SECRET: key("AUTH_SECRET"),
  AUTH_URL: origin,
  NODE_ENV: "production",
  HOST: "0.0.0.0",
  PORT: "3107",
  RELAY_TRUSTED_PROXY_COUNT: "0",
  RELAY_SANDBOX: "1",
  RELAY_PUBLIC_FORM: "1",
  RELAY_SANDBOX_URL: origin,
  RELAY_PAYMENT_WEBHOOK_SECRET: key("RELAY_PAYMENT_WEBHOOK_SECRET"),
  RELAY_RECONCILE_SECRET: reconcile,
  RELAY_OUTBOX_SECRET: outbox,
  RELAY_RECONCILE_FIRST_MS: "0",
  RELAY_RECONCILE_INTERVAL_MS: "60000",
  RELAY_SANDBOX_LATE_MS: "60000",
});
process.stdout.write("Local demo configuration is ready.\n");
