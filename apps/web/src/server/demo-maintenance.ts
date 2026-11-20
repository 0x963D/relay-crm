import { openStore } from "@relay/store";
import { demoSchedule, resetDemo, seedDemo } from "@relay/store/demo";
import { demoOptions } from "./demo.ts";
import type { Env } from "./env.ts";

export async function maintainDemo(env: Env, ownerUrl: string, at?: Date) {
  const schedule = await demoSchedule(ownerUrl, env.timeZone, at);
  if (schedule.seededAt >= schedule.start)
    return { state: "current", next: schedule.next } as const;
  await resetDemo({ ...demoOptions(env, ownerUrl, at), demo: env.demo });
  return { state: "reset" } as const;
}

export async function recoverDemoSeed(env: Env, ownerUrl: string, at = new Date()) {
  const store = openStore({ connectionString: env.databaseUrl });
  try {
    const ready = await store.databaseReady().catch(() => false);
    if (!ready) throw new Error("Demo database is not ready. Apply migrations before maintenance.");
  } finally {
    await store.close();
  }
  return seedDemo(demoOptions(env, ownerUrl, at));
}
