import nodemailer from "nodemailer";
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
