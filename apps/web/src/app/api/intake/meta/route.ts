import { composition } from "@/server/composition.ts";

export function GET(request: Request): Promise<Response> {
  return composition().metaWebhook.GET(request);
}

export function POST(request: Request): Promise<Response> {
  return composition().metaWebhook.POST(request);
}
