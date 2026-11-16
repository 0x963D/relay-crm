import { protectHttp } from "@/server/errors.ts";
import { composition } from "@/server/composition.ts";

export function GET(request: Request): Promise<Response> {
  return protectHttp("meta.failed", () => composition().metaWebhook.GET(request));
}

export function POST(request: Request): Promise<Response> {
  return protectHttp("meta.failed", () => composition().metaWebhook.POST(request));
}
