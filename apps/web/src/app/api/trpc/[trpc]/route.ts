import { protectHttp } from "@/server/errors.ts";
import { composition } from "@/server/composition.ts";
import { rpcContext } from "@/server/rpc-context";
import { handleRpc } from "@/server/rpc.ts";
function handle(request: Request) {
  return protectHttp("rpc.failed", () => {
    const app = composition();
    const origin = new URL(app.env.auth?.baseUrl ?? request.url).origin;
    return handleRpc(
      request,
      ({ publicQuery }) => rpcContext(request.headers, publicQuery),
      origin,
    );
  });
}
export { handle as GET, handle as POST };
