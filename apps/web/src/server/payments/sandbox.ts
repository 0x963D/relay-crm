import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { isCurrencyCode, SANDBOX_MODES, type PaymentProvider } from "@relay/domain";
import type { Store } from "@relay/store";
import type { PaymentEnv } from "../env.ts";
import { signPaymentBody } from "./webhook.ts";
import { reportFailure } from "../errors.ts";
import { readBody } from "../http.ts";
import { sandboxPage } from "./sandbox-page.ts";

export function sandboxProvider(store: Store, env: PaymentEnv): PaymentProvider {
  return {
    createCheckout: async (input) => {
      const row = await store.createSandboxCheckout({
        ...input,
        expiresAt: new Date(Date.now() + env.checkoutTtlMs),
      });
      return { id: row.id, url: row.token ? `${env.baseUrl}/sandbox/checkout/${row.token}` : null };
    },
    cancelCheckout: (id) => store.cancelSandboxCheckout(id),
    readPayment: async (id) => {
      const row = await store.getSandboxCheckout(id);
      if (!row) return { status: "missing" };
      if (
        !isCurrencyCode(row.currency) ||
        (row.status !== "pending" &&
          row.status !== "completed" &&
          row.status !== "failed" &&
          row.status !== "expired")
      )
        throw new Error("Sandbox status unavailable");
      return { status: row.status, money: { minor: row.amount, currency: row.currency } };
    },
  };
}
export function sandboxCheckout(
  store: Store,
  env: PaymentEnv,
  defer: (task: () => Promise<void>) => void,
  demo = false,
  hosted = false,
) {
  return async (request: Request, id: string): Promise<Response> => {
    const row = await store.getSandboxCheckoutByToken(id);
    if (!row) return new Response(null, { status: 404 });
    if (request.method === "GET") {
      const nonce = randomUUID();
      return new Response(sandboxPage(row, demo, env.lateMs, nonce, hosted), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        },
      });
    }
    const sameOrigin =
      request.headers.get("origin") === env.baseUrl ||
      (request.headers.get("origin") === "null" &&
        request.headers.get("sec-fetch-site") === "same-origin");
    if (!sameOrigin) return new Response(null, { status: 403 });
    const body = await readBody(request);
    if (body === null) return new Response(null, { status: 413 });
    const value = new URLSearchParams(new TextDecoder().decode(body)).get("mode");
    const mode = demo ? SANDBOX_MODES.find((choice) => choice === value) : undefined;
    if (demo && value !== null && !mode) return new Response(null, { status: 400 });
    const paid = await store.paySandboxCheckout(id, mode);
    if (paid && paid.mode !== "drop") {
      defer(async () => {
        if (paid.mode === "late") await sleep(env.lateMs);
        const body = new TextEncoder().encode(
          JSON.stringify({
            eventId: paid.eventId,
            paymentId: paid.paymentId,
            status: paid.status,
            amount: paid.amount.toString(),
            currency: paid.currency,
          }),
        );
        const deliveries = paid.mode === "twice" ? 2 : 1;
        for (let delivery = 0; delivery < deliveries; delivery += 1) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              const timestamp = Math.floor(Date.now() / 1000).toString();
              const response = await fetch(
                `${env.deliveryUrl ?? env.baseUrl}/api/payments/webhook`,
                {
                  method: "POST",
                  body,
                  headers: {
                    "content-type": "application/json",
                    "x-sandbox-timestamp": timestamp,
                    "x-sandbox-signature": signPaymentBody(env.webhookSecret, timestamp, body),
                  },
                  signal: AbortSignal.timeout(5000),
                },
              );
              if (response.ok) break;
              if (response.status < 500) throw new Error("Sandbox webhook was refused");
            } catch (error) {
              reportFailure("sandbox.deliveryFailed", error);
            }
            await sleep(100 * (attempt + 1));
          }
        }
      });
    }
    return new Response(null, {
      status: 303,
      headers: { location: `${env.baseUrl}/sandbox/checkout/${id}` },
    });
  };
}
