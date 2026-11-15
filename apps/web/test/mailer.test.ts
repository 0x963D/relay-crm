import { describe, expect, it, vi } from "vitest";
import { createMailer } from "../src/server/mailer.ts";
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
