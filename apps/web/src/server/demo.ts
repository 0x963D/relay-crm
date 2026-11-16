import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Env } from "./env.ts";
import { createReceiptMailer } from "./mailer.ts";

export async function demoOwnerUrl(file: string) {
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  return z.object({ ownerUrl: z.url() }).parse(value).ownerUrl;
}

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
