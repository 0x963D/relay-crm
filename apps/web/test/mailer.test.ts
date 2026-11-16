import dns from "node:dns";
import { createSocket } from "node:dgram";
import { once } from "node:events";
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

it("retries a refused local SMTP connection", async () => {
  const inbox = await openSmtpInbox();
  await inbox.close();
  const send = createReceiptMailer({ kind: "smtp", url: inbox.url, from: "relay@sender.example" });
  expect(
    await send(
      {
        id: "fake-receipt",
        paymentId: "fake-payment",
        email: "recipient@example.com",
        amount: "48000",
        currency: "GBP",
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ state: "failed" });
});

it.each(["greeting", "recipient"] as const)(
  "retries a local SMTP %s failure before DATA",
  async (fault) => {
    const inbox = await openSmtpInbox(() => "sent", fault);
    try {
      const send = createReceiptMailer(
        { kind: "smtp", url: inbox.url, from: "relay@sender.example" },
        { greetingTimeout: 100 },
      );
      expect(
        await send(
          {
            id: "fake-receipt",
            paymentId: "fake-payment",
            email: "recipient@example.com",
            amount: "48000",
            currency: "GBP",
          },
          new AbortController().signal,
        ),
      ).toMatchObject({ state: "failed" });
      expect(inbox.messages).toHaveLength(0);
    } finally {
      await inbox.close();
    }
  },
);

it("retries a DNS timeout against a local DNS server", async () => {
  const server = createSocket("udp4");
  let queries = 0;
  server.on("message", () => {
    queries++;
  });
  server.bind(0, "127.0.0.1");
  await once(server, "listening");
  const Resolver = dns.Resolver;
  const resolver = vi.spyOn(dns, "Resolver").mockImplementation(
    class extends Resolver {
      constructor(options?: ConstructorParameters<typeof Resolver>[0]) {
        super(options);
        this.setServers([`127.0.0.1:${String(server.address().port)}`]);
      }
    },
  );
  try {
    const send = createReceiptMailer(
      { kind: "smtp", url: "smtp://fake-receipt-mail.invalid:25", from: "relay@sender.example" },
      { dnsTimeout: 100 },
    );
    expect(
      await send(
        {
          id: "fake-receipt",
          paymentId: "fake-payment",
          email: "recipient@example.com",
          amount: "48000",
          currency: "GBP",
        },
        new AbortController().signal,
      ),
    ).toEqual({ state: "failed", reason: "Could not resolve the mail server address." });
    expect(queries).toBeGreaterThan(0);
  } finally {
    resolver.mockRestore();
    server.close();
  }
});
