import { AccessError } from "./errors.ts";
import type { Db } from "./tx.ts";

export const DEMO_KEY = "tidewell-language-school/v1";
export const DEMO_COMPANY = "Tidewell Language School";
export const DEMO_ROLES = ["manager", "agent", "accountant"] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];
export const DEMO_PEOPLE = {
  manager: {
    id: "00000000-0000-7000-8000-000000000101",
    name: "Priya Raman",
    email: "priya.raman@tidewell.example",
  },
  agent: {
    id: "00000000-0000-7000-8000-000000000102",
    name: "Dele Akinwale",
    email: "dele.akinwale@tidewell.example",
  },
  accountant: {
    id: "00000000-0000-7000-8000-000000000103",
    name: "Esther Okafor",
    email: "esther.okafor@tidewell.example",
  },
} as const;

export async function demoReady(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<{ ready: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM demo_seed WHERE key=${DEMO_KEY} AND state='ready') AS ready`;
  return rows[0]?.ready === true;
}

export async function demoPerson(db: Db, role: DemoRole) {
  if (!(await demoReady(db))) throw new AccessError("accessDenied");
  const identity = DEMO_PEOPLE[role];
  const user = await db.user.findFirst({ where: { id: identity.id, email: identity.email, role } });
  if (!user) throw new AccessError("accessDenied");
  return user;
}

export const REQUIRED_MIGRATION = "0009_native_sessions";

export async function databaseReady(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<
    { ready: boolean }[]
  >`SELECT public.relay_ready(${REQUIRED_MIGRATION}) AS ready`;
  return rows[0]?.ready === true;
}
