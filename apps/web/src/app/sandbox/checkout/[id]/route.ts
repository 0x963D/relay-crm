import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
async function handle(request: Request, context: { params: Promise<{ id: string }> }) {
  const response = await protectHttp(
    "sandbox.failed",
    async () =>
      composition().payments?.checkout(request, (await context.params).id) ??
      new Response(null, { status: 404 }),
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
export { handle as GET, handle as POST };
