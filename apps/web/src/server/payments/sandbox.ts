import { setTimeout as sleep } from "node:timers/promises";
import { PaymentId, isCurrencyCode, type PaymentProvider } from "@relay/domain";
import type { Store } from "@relay/store";
import type { PaymentEnv } from "../env.ts";
import { signPaymentBody } from "./webhook.ts";
import { reportFailure } from "../errors.ts";
import { readBody } from "../http.ts";

export function sandboxProvider(store: Store, env: PaymentEnv): PaymentProvider {
  return {
    createCheckout: async (input) => {
      const row = await store.createSandboxCheckout(input);
      return { id: row.id, url: `${env.baseUrl}/sandbox/checkout/${row.id}` };
    },
    readPayment: async (id) => {
      const row = await store.getSandboxCheckout(id);
      if (
        !row ||
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
) {
  return async (request: Request, id: string): Promise<Response> => {
    if (!PaymentId.is(id)) return new Response(null, { status: 404 });
    const row = await store.getSandboxCheckout(id);
    if (!row) return new Response(null, { status: 404 });
    if (request.method === "GET") {
      return new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sandbox checkout</title></head><body><h1>Sandbox checkout</h1><p>This is a test. No real money moves.</p><p>${row.amount.toString()} minor units, ${row.currency}. Status: ${row.status}.</p><form method="post"><button type="submit"${row.status !== "pending" ? " disabled" : ""}>Pay in sandbox</button></form></body></html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; form-action 'self'; frame-ancestors 'none'",
          },
        },
      );
    }
    if (request.headers.get("origin") !== env.baseUrl) return new Response(null, { status: 403 });
    if ((await readBody(request)) === null) return new Response(null, { status: 413 });
    const paid = await store.paySandboxCheckout(id);
    if (paid && paid.mode !== "drop") {
      defer(async () => {
        if (paid.mode === "late") await sleep(env.lateMs);
        const body = new TextEncoder().encode(
          JSON.stringify({
            eventId: paid.eventId,
            paymentId: paid.id,
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
              const response = await fetch(`${env.baseUrl}/api/payments/webhook`, {
                method: "POST",
                body,
                headers: {
                  "content-type": "application/json",
                  "x-sandbox-timestamp": timestamp,
                  "x-sandbox-signature": signPaymentBody(env.webhookSecret, timestamp, body),
                },
                signal: AbortSignal.timeout(5000),
              });
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
