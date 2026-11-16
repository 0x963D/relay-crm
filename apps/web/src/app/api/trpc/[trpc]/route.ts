import { protectHttp } from "@/server/errors.ts";
import { composition } from "@/server/composition.ts";
import { resolvePrincipal } from "@/server/actor.ts";
import { handleRpc } from "@/server/rpc.ts";
function handle(request: Request) {
  return protectHttp("rpc.failed", () => {
    const app = composition();
    const origin = new URL(app.env.auth?.baseUrl ?? request.url).origin;
    return handleRpc(
      request,
      async () => ({
        store: app.store,
        payments:
          app.payments && app.env.payments
            ? { provider: app.payments.provider, firstCheckMs: app.env.payments.firstCheckMs }
            : null,
        principal: await resolvePrincipal(app, request.headers),
      }),
      origin,
    );
  });
}
export { handle as GET, handle as POST };
