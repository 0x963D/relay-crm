import { composition } from "@/server/composition.ts";

export function POST(request: Request): Promise<Response> {
  return composition().webForm.POST(request);
}
