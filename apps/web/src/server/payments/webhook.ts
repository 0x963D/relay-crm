import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { PaymentId, isCurrencyCode } from "@relay/domain";
import { AccessError, type Store } from "@relay/store";
import { z } from "zod";
import { readBody } from "../http.ts";
import { reportFailure } from "../errors.ts";

export function signPaymentBody(secret: string, timestamp: string, body: Uint8Array): string {
  return createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex");
}
export function equalSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function verifyPaymentSignature(
  secret: string,
  timestamp: string,
  signature: string,
  body: Uint8Array,
  now: Date,
): boolean {
  if (!/^\d{1,12}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(now.getTime() - Number(timestamp) * 1000) > 300000) return false;
  return equalSecret(signature, signPaymentBody(secret, timestamp, body));
}
const Event = z
  .object({
    eventId: z.string().min(1).max(200),
    paymentId: z.uuid(),
    status: z.enum(["pending", "completed", "failed", "expired"]),
    amount: z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .refine((v) => BigInt(v) <= 9223372036854775807n),
    currency: z.string().refine(isCurrencyCode),
  })
  .strict();
export function paymentWebhook(store: Store, secret: string) {
  return async (request: Request): Promise<Response> => {
    try {
      const body = await readBody(request);
      if (body === null) return new Response(null, { status: 413 });
      if (
        !verifyPaymentSignature(
          secret,
          request.headers.get("x-sandbox-timestamp") ?? "",
          request.headers.get("x-sandbox-signature") ?? "",
          body,
          new Date(),
        )
      )
        return new Response(null, { status: 401 });
      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return new Response(null, { status: 400 });
      }
      const parsed = Event.safeParse(input);
      if (!parsed.success) return new Response(null, { status: 400 });
      const { eventId, paymentId, status, amount, currency } = parsed.data;
      const id = PaymentId.parse(paymentId);
      if (!id || !isCurrencyCode(currency)) return new Response(null, { status: 400 });
      await store.receivePaymentWebhook({
        eventId,
        paymentId: id,
        payloadHash: createHash("sha256").update(body).digest("hex"),
        observed: { status, money: { minor: BigInt(amount), currency } },
      });
      return Response.json({ recorded: true });
    } catch (error) {
      if (error instanceof AccessError && error.code === "accessDenied")
        return new Response(null, { status: 400 });
      if (error instanceof AccessError && error.code === "conflict")
        return new Response(null, { status: 409 });
      const failure = reportFailure("paymentWebhook.failed", error);
      return Response.json(failure, { status: 500 });
    }
  };
}
