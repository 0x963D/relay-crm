import { protectHttp } from "@/server/errors.ts";
import { composition } from "@/server/composition.ts";

export function POST(request: Request): Promise<Response> {
  return protectHttp("webForm.failed", () => composition().webForm.POST(request));
}
