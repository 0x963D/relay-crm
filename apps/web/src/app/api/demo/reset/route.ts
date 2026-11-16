import { resetDemo } from "@relay/store/demo";
import { composition } from "@/server/composition.ts";
import { demoOptions, demoOwnerUrl } from "@/server/demo.ts";
import { protectHttp } from "@/server/errors.ts";
import { authorizeJob } from "@/server/rate-limit.ts";
import { readBody } from "@/server/http.ts";

export function POST(request: Request) {
  return protectHttp("demo.resetFailed", async () => {
    const { env, store } = composition();
    if (!env.demo || !env.demoResetSecret || !env.demoOwnerFile)
      return new Response(null, { status: 404 });
    const denied = await authorizeJob(
      store,
      request,
      "demo-reset",
      env.demoResetSecret,
      env.trustedProxyCount,
    );
    if (denied) return denied;
    if ((await readBody(request)) === null) return new Response(null, { status: 413 });
    await resetDemo({ ...demoOptions(env, await demoOwnerUrl(env.demoOwnerFile)), demo: env.demo });
    return new Response(null, { status: 204 });
  });
}
