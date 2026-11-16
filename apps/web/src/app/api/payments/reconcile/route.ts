import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
import { authorizeJob, rateLimited } from "@/server/rate-limit.ts";
import { reconcilePayments } from "@/server/payments/reconcile.ts";
import { readBody } from "@/server/http.ts";
export function POST(request: Request) {
  return protectHttp("reconcile.failed", async () => {
    const app = composition();
    if (!app.payments || !app.env.payments) return new Response(null, { status: 404 });
    const denied = await authorizeJob(
      app.store,
      request,
      "reconcile",
      app.env.payments.reconcileSecret,
      app.env.trustedProxyCount,
    );
    if (denied) return denied;
    if ((await readBody(request)) === null) return new Response(null, { status: 413 });
    const payments = app.payments;
    const intervalMs = app.env.payments.intervalMs;
    const run = await app.store.exclusiveJob("reconcile", () =>
      reconcilePayments(app.store, payments.provider, intervalMs),
    );
    if (!run.ran) return rateLimited();
    const results = run.result;
    return Response.json({
      checked: results.length,
      changed: results.filter((r) => r.changed).length,
    });
  });
}
