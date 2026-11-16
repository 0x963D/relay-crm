import { sandboxProvider, sandboxCheckout } from "./payments/sandbox.ts";
import { paymentWebhook } from "./payments/webhook.ts";
import { after } from "next/server";
import { createAuthentication, type Authentication } from "./auth.ts";
import { createReceiptMailer, createMailer } from "./mailer.ts";
import { openStore, type Store } from "@relay/store";
import { readEnv, type Env } from "./env.ts";
import { createMetaLeadSource } from "./intake/meta/lead-source.ts";
import { createMetaWebhook, type WebhookHandlers } from "./intake/meta/webhook.ts";
import { createWebFormEndpoint, type WebFormEndpoint } from "./intake/web-form.ts";
import { logToConsole } from "./log.ts";

/** Every long-lived object the application has. This file is the only one that builds any. */
export interface Composition {
  readonly receiptMailer: ReturnType<typeof createReceiptMailer> | null;
  readonly payments: {
    readonly provider: ReturnType<typeof sandboxProvider>;
    readonly webhook: ReturnType<typeof paymentWebhook>;
    readonly checkout: ReturnType<typeof sandboxCheckout>;
  } | null;
  readonly auth: Authentication | null;
  readonly env: Env;
  readonly store: Store;
  readonly metaWebhook: WebhookHandlers;
  readonly webForm: WebFormEndpoint;
}

function compose(env: Env): Composition {
  const store = openStore({ connectionString: env.databaseUrl, receipts: env.receipts });
  const now = (): Date => new Date();
  const log = logToConsole;

  return {
    env,
    store,
    receiptMailer: env.smtp ? createReceiptMailer(env.smtp) : null,
    payments: env.payments
      ? {
          provider: sandboxProvider(store, env.payments),
          webhook: paymentWebhook(store, env.payments.webhookSecret),
          checkout: sandboxCheckout(store, env.payments, (task) => {
            after(task);
          }),
        }
      : null,
    auth:
      env.auth === null
        ? null
        : createAuthentication(
            store,
            env.auth,
            createMailer(env.auth.delivery),
            (task) => {
              after(async () => {
                try {
                  await task();
                } catch {
                  log("signInMailFailed", {});
                }
              });
            },
            env.demo,
          ),
    metaWebhook: createMetaWebhook(
      env.meta && {
        verifyToken: env.meta.verifyToken,
        appSecret: env.meta.appSecret,
        leads: createMetaLeadSource({
          accessToken: env.meta.accessToken,
          appSecret: env.meta.appSecret,
          graphVersion: env.meta.graphVersion,
          baseUrl: env.meta.graphBaseUrl,
          fetch,
        }),
        intake: store.intake,
        now,
        log,
      },
    ),
    webForm: createWebFormEndpoint({
      enabled: env.publicForm,
      intake: store.intake,
      limits: store,
      trustedProxyCount: env.trustedProxyCount,
      now,
      log,
    }),
  };
}

declare global {
  var relayComposition: Composition | undefined;
}

/**
 * Builds the composition on first use, so importing a route reads no environment and opens no
 * pool, and `next build` needs no database. It is kept on `globalThis` because Next.js can load
 * this module more than once in one process, and each copy would otherwise open its own pool.
 */
export function composition(): Composition {
  return (globalThis.relayComposition ??= compose(readEnv()));
}
