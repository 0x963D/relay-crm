import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
import { authorizeJob } from "@/server/rate-limit.ts";
import { readBody } from "@/server/http.ts";
import { runOutbox } from "@/server/payments/jobs.ts";

export function POST(request: Request) {
  return protectHttp("outbox.failed", async () => {
    const app = composition();
    if (!app.receiptMailer || !app.env.outboxSecret) return new Response(null, { status: 404 });
    const denied = await authorizeJob(
      app.store,
      request,
      "outbox",
      app.env.outboxSecret,
      app.env.trustedProxyCount,
    );
    if (denied) return denied;
    if ((await readBody(request)) === null) return new Response(null, { status: 413 });
    return runOutbox(app.store, app.receiptMailer);
  });
}
