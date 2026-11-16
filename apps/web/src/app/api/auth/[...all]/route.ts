import { protectHttp } from "@/server/errors.ts";
import { composition } from "@/server/composition.ts";
function handle(request: Request): Promise<Response> | Response {
  return protectHttp("auth.failed", () => {
    const auth = composition().auth;
    return auth === null ? new Response(null, { status: 404 }) : auth.handle(request);
  });
}
export { handle as GET, handle as POST };
