import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
import { readBody } from "@/server/http.ts";
import { runOutbox, runReconcile } from "@/server/payments/jobs.ts";
import { authorizeJob } from "@/server/rate-limit.ts";

export const maxDuration = 300;

export function POST(request: Request) {
  return protectHttp("demoJobs.failed", async () => {
    const { env, store, payments, receiptMailer } = composition();
    if (!env.scheduledSecret || !env.payments || !payments || !receiptMailer)
      return new Response(null, { status: 404 });
    const denied = await authorizeJob(
      store,
      request,
      "demo",
      env.scheduledSecret,
      env.trustedProxyCount,
    );
    if (denied) return denied;
    if ((await readBody(request)) === null) return new Response(null, { status: 413 });
    const intervalMs = env.payments.intervalMs;
    const reconcile = await protectHttp("reconcile.failed", () =>
      runReconcile(store, payments.provider, intervalMs),
    );
    const outbox = await protectHttp("outbox.failed", () => runOutbox(store, receiptMailer));
    const complete = [reconcile, outbox].every((job) => job.ok || job.status === 429);
    return Response.json(
      { reconcile: reconcile.status, outbox: outbox.status },
      { status: complete ? 200 : 503 },
    );
  });
}
