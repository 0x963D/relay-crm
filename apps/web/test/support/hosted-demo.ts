import { randomBytes } from "node:crypto";

export function hostedDemoEnv(origin: string) {
  const secret = () => randomBytes(32).toString("base64url");
  return {
    RELAY_DEMO: "1",
    RELAY_EMAIL_MODE: "disabled",
    AUTH_URL: origin,
    AUTH_SECRET: secret(),
    RELAY_SANDBOX: "1",
    RELAY_SANDBOX_URL: origin,
    RELAY_PAYMENT_WEBHOOK_SECRET: secret(),
    RELAY_RECONCILE_SECRET: secret(),
    RELAY_OUTBOX_SECRET: secret(),
    CRON_SECRET: secret(),
    RELAY_TRUSTED_PROXY_COUNT: "1",
    RELAY_RECONCILE_FIRST_MS: "0",
    RELAY_RECONCILE_INTERVAL_MS: "60000",
  };
}
