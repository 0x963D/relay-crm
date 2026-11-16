import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
import { authorizeJob, rateLimited } from "@/server/rate-limit.ts";
import { readBody } from "@/server/http.ts";
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
    const mailer = app.receiptMailer;
    const run = await app.store.exclusiveJob("outbox", (signal) =>
      app.store.runOutbox(mailer, { signal }),
    );
    if (!run.ran) return rateLimited();
    const results = run.result;
    return Response.json({
      processed: results.length,
      recordingFailed: results.filter((r) => r.state === "recordingFailed").length,
      superseded: results.filter((r) => r.state === "superseded").length,
      sent: results.filter((r) => r.state === "sent").length,
      failed: results.filter((r) => r.state === "failed").length,
      suppressed: results.filter((r) => r.state === "suppressed").length,
      unknown: results.filter((r) => r.state === "unknown").length,
    });
  });
}
