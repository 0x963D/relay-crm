import {
  formatAmount,
  isCurrencyCode,
  type ReceiptMessage,
  type DeliveryOutcome,
} from "@relay/domain";
import nodemailer from "nodemailer";
import type { SMTPConnectionOptions } from "nodemailer/lib/smtp-connection";
import type { AuthEnv } from "./env.ts";

export type Mailer = (message: { readonly email: string; readonly code: string }) => Promise<void>;

export function createMailer(delivery: AuthEnv["delivery"]): Mailer {
  if (delivery.kind === "developmentConsole") {
    return ({ email, code }) => {
      // eslint-disable-next-line no-console -- parseEnv permits this sink only in development.
      console.info(JSON.stringify({ event: "developmentSignInCode", email, code }));
      return Promise.resolve();
    };
  }
  const transport = nodemailer.createTransport(delivery.url);
  return async ({ email, code }) => {
    await transport.sendMail({
      from: delivery.from,
      to: email,
      subject: "Your Relay sign-in code",
      text: `Your sign-in code is ${code}. It expires in 5 minutes.`,
    });
  };
}

export function createReceiptMailer(
  delivery: Extract<AuthEnv["delivery"], { kind: "smtp" }>,
  timeouts: Pick<
    SMTPConnectionOptions,
    "connectionTimeout" | "greetingTimeout" | "socketTimeout" | "dnsTimeout"
  > = {},
) {
  return async (receipt: ReceiptMessage, signal: AbortSignal): Promise<DeliveryOutcome> => {
    const transmission = { started: false };
    const transport = nodemailer.createTransport({
      url: delivery.url,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      ...timeouts,
      debug: true,
      // Nodemailer reports CONN even after DATA. Observe transmission without retaining its contents.
      logger: {
        debug(entry: { tnx?: string }) {
          if (entry.tnx === "message") transmission.started = true;
        },
      },
    });
    if (!receipt.email)
      return { state: "failed", reason: "The account has no receipt email address." };
    if (!isCurrencyCode(receipt.currency)) throw new Error("Invalid receipt currency");
    try {
      const message = {
        from: delivery.from,
        to: receipt.email,
        messageId: `<relay-receipt-${receipt.id}@relay.invalid>`,
        subject: "Your Relay payment receipt",
        text: `Payment ${receipt.paymentId}\nReceived ${receipt.currency} ${formatAmount({ minor: BigInt(receipt.amount), currency: receipt.currency })}.\nYour account has been credited.\n`,
        signal,
      };
      await transport.sendMail(message);
      return { state: "sent" };
    } catch (error) {
      const responseCode: unknown =
        typeof error === "object" && error !== null && "responseCode" in error
          ? error.responseCode
          : undefined;
      const code: unknown =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (typeof responseCode === "number" && responseCode >= 400)
        return {
          state: "failed",
          reason: `The mail server refused delivery with SMTP ${String(responseCode)}.`,
        };
      if (!transmission.started)
        return {
          state: "failed",
          reason:
            code === "EDNS"
              ? "Could not resolve the mail server address."
              : code === "ESOCKET"
                ? "Could not connect to the mail server."
                : code === "ETIMEDOUT"
                  ? "The mail server timed out before message data was sent."
                  : "Delivery stopped before message data was sent.",
        };
      return {
        state: "unknown",
        reason:
          "The connection ended before the mail server confirmed delivery. The receipt may have arrived.",
      };
    }
  };
}
