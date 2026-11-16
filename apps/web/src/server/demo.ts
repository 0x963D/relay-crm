import type { Env } from "./env.ts";
import { createReceiptMailer } from "./mailer.ts";

export function demoOptions(env: Env, ownerUrl: string, today = new Date()) {
  if (!env.smtp) throw new Error("Demo setup requires an SMTP sink.");
  return {
    appUrl: env.databaseUrl,
    ownerUrl,
    today,
    timeZone: env.timeZone,
    deliver: createReceiptMailer(env.smtp),
  };
}
