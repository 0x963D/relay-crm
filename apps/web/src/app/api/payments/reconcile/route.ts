import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
import { equalSecret } from "@/server/payments/webhook.ts";
import { reconcilePayments } from "@/server/payments/reconcile.ts";
import { readBody } from "@/server/http.ts";
export function POST(request: Request) {
  return protectHttp("reconcile.failed", async () => {
    const app = composition();
    if (!app.payments || !app.env.payments) return new Response(null, { status: 404 });
    if (
      !equalSecret(
        request.headers.get("authorization") ?? "",
        `Bearer ${app.env.payments.reconcileSecret}`,
      )
    )
      return new Response(null, { status: 401 });
    if ((await readBody(request)) === null) return new Response(null, { status: 413 });
    return Response.json(
      await reconcilePayments(app.store, app.payments.provider, app.env.payments.intervalMs),
    );
  });
}
