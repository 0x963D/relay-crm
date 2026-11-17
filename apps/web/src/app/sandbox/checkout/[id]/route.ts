import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
async function handle(request: Request, context: { params: Promise<{ id: string }> }) {
  return protectHttp(
    "sandbox.failed",
    async () =>
      composition().payments?.checkout(request, (await context.params).id) ??
      new Response(null, { status: 404 }),
  );
}
export { handle as GET, handle as POST };
