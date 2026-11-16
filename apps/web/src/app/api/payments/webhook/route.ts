import { composition } from "@/server/composition.ts";
import { protectHttp } from "@/server/errors.ts";
export function POST(request: Request) {
  return protectHttp(
    "paymentWebhook.failed",
    () => composition().payments?.webhook(request) ?? new Response(null, { status: 404 }),
  );
}
