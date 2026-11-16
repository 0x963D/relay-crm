import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
import { equalSecret } from "@/server/payments/webhook.ts";
import { readBody } from "@/server/http.ts";
export function POST(request: Request) {
  return protectHttp("outbox.failed", async () => {
    const app = composition();
    if (!app.receiptMailer || !app.env.outboxSecret) return new Response(null, { status: 404 });
    if (!equalSecret(request.headers.get("authorization") ?? "", `Bearer ${app.env.outboxSecret}`))
      return new Response(null, { status: 401 });
    if ((await readBody(request)) === null) return new Response(null, { status: 413 });
    return Response.json(await app.store.runOutbox(app.receiptMailer));
  });
}
