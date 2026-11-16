import { createHash } from "node:crypto";
import type { Store } from "@relay/store";

export const RATE_WINDOW_SECONDS = 60;

export function limitKey(scope: string, identity: string): string {
  return `${scope}:${createHash("sha256").update(identity).digest("hex")}`;
}

export async function allowRequest(
  store: Pick<Store, "takeRequestLimit">,
  budgets: readonly { readonly key: string; readonly max: number }[],
): Promise<boolean> {
  for (const budget of budgets) {
    if (!(await store.takeRequestLimit(budget.key, budget.max, RATE_WINDOW_SECONDS))) return false;
  }
  return true;
}

export function rateLimited(): Response {
  return Response.json(
    { error: "Try again later." },
    {
      status: 429,
      headers: { "retry-after": String(RATE_WINDOW_SECONDS) },
    },
  );
}
