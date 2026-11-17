import { composition } from "./composition";
import { resolvePrincipal } from "./actor";
import type { RpcContext } from "./rpc";

export async function rpcContext(headers: Headers, publicQuery = false): Promise<RpcContext> {
  const app = composition();
  return {
    store: app.store,
    demo: app.env.demo,
    timeZone: app.env.timeZone,
    principal: publicQuery ? null : await resolvePrincipal(app, headers),
    payments:
      app.payments && app.env.payments
        ? {
            provider: app.payments.provider,
            firstCheckMs: app.env.payments.firstCheckMs,
            intervalMs: app.env.payments.intervalMs,
          }
        : null,
  };
}
