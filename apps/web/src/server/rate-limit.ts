import { clientAddress } from "./client-address.ts";
import { equalSecret } from "./payments/webhook.ts";
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

export async function authorizeJob(
  store: Pick<Store, "takeRequestLimit">,
  request: Request,
  route: string,
  secret: string,
  trustedProxyCount: number,
): Promise<Response | null> {
  if (equalSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) return null;
  const allowed = await allowRequest(store, [
    { key: limitKey(`job:${route}:failed`, clientAddress(request, trustedProxyCount)), max: 5 },
  ]);
  return allowed ? new Response(null, { status: 401 }) : rateLimited();
}
