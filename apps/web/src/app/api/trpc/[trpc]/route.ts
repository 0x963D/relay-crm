import { composition } from "@/server/composition.ts";
import { resolvePrincipal } from "@/server/actor.ts";
import { handleRpc } from "@/server/rpc.ts";
function handle(request: Request) {
  const app = composition();
  const origin = new URL(app.env.auth?.baseUrl ?? request.url).origin;
  return handleRpc(
    request,
    async () => ({ store: app.store, principal: await resolvePrincipal(app, request.headers) }),
    origin,
  );
}
export { handle as GET, handle as POST };
