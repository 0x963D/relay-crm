import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
import { authorizeJob } from "@/server/rate-limit.ts";
import { readBody } from "@/server/http.ts";
import { runReconcile } from "@/server/payments/jobs.ts";

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
    return runReconcile(app.store, app.payments.provider, app.env.payments.intervalMs);
  });
}
