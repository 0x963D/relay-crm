import type { Env } from "./env.ts";
import { createReceiptMailer } from "./mailer.ts";

export function demoOptions(env: Env, ownerUrl: string, today = new Date()) {
  if (!env.email) throw new Error("Demo setup requires an SMTP sink or disabled email.");
  return {
    appUrl: env.databaseUrl,
    ownerUrl,
    today,
    timeZone: env.timeZone,
    deliver: createReceiptMailer(env.email),
  };
}
