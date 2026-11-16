import { describe, expect, it, vi } from "vitest";
import { createMailer, createReceiptMailer } from "../src/server/mailer.ts";
import { parseEnv } from "../src/server/env.ts";
import { openSmtpInbox } from "./support/smtp.ts";

const auth = {
  DATABASE_URL: "postgresql://fake:fake@127.0.0.1:54329/fake",
  AUTH_SECRET: "fake-secret-for-tests-at-least-thirty-two-characters",
  AUTH_URL: "https://relay.example",
};

describe("code delivery", () => {
  it("permits console codes only under the development environment", () => {
    expect(() => parseEnv({ ...auth, NODE_ENV: "production" })).toThrow("needs SMTP");
    expect(() => parseEnv({ ...auth, NODE_ENV: "test" })).toThrow("needs SMTP");
    expect(parseEnv({ ...auth, NODE_ENV: "development" }).auth?.delivery).toEqual({
      kind: "developmentConsole",
    });
  });
  it("sends through SMTP without logging the code", async () => {
    const inbox = await openSmtpInbox();
    const output = vi.spyOn(console, "info");
    try {
      const mailer = createMailer({ kind: "smtp", url: inbox.url, from: "relay@sender.example" });
      await mailer({ email: "recipient@example.com", code: "123456" });
      expect(inbox.messages[0]).toContain("Your sign-in code is 123456");
      expect(inbox.messages[0]).toContain("To: recipient@example.com");
      expect(output).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      await inbox.close();
    }
  });
});

it("receipt delivery preserves Message-ID across attempts", async () => {
  const inbox = await openSmtpInbox();
  try {
    const mailer = createReceiptMailer({
      kind: "smtp",
      url: inbox.url,
      from: "relay@sender.example",
    });
    const message = {
      id: "00000000-0000-4000-8000-000000000001",
      paymentId: "fake-payment",
      email: "recipient@example.com",
      amount: "48000",
      currency: "GBP",
    };
    const signal = new AbortController().signal;
    expect(await mailer(message, signal)).toEqual({ state: "sent" });
    expect(await mailer(message, signal)).toEqual({ state: "sent" });
    for (const received of inbox.messages) {
      expect(received.replace(/\n[ \t]+/g, " ")).toContain(
        "Message-ID: <relay-receipt-00000000-0000-4000-8000-000000000001@relay.invalid>",
      );
      expect(received.replace(/\n[ \t]+/g, " ")).toContain("Received GBP 480.00.");
    }
  } finally {
    await inbox.close();
  }
});

it.each(["failed", "unknown"] as const)("classifies a real SMTP %s outcome", async (state) => {
  const inbox = await openSmtpInbox(() => state);
  try {
    const mailer = createReceiptMailer({
      kind: "smtp",
      url: inbox.url,
      from: "relay@sender.example",
    });
    expect(
      await mailer(
        {
          id: "fake-receipt",
          paymentId: "fake-payment",
          email: "recipient@example.com",
          amount: "48000",
          currency: "GBP",
        },
        new AbortController().signal,
      ),
    ).toMatchObject({ state });
    expect(inbox.messages).toHaveLength(1);
  } finally {
    await inbox.close();
  }
});
