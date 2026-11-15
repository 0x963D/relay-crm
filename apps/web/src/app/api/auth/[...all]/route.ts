import { composition } from "@/server/composition.ts";
function handle(request: Request): Promise<Response> | Response {
  const auth = composition().auth;
  return auth === null ? new Response(null, { status: 404 }) : auth.handle(request);
}
export { handle as GET, handle as POST };
