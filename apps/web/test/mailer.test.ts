import { once } from "node:events";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createMailer } from "../src/server/mailer.ts";
import { parseEnv } from "../src/server/env.ts";

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
    let message = "";
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.write("220 relay.example ESMTP\r\n");
      let buffer = "",
        data = false;
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const end = buffer.indexOf("\r\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (data) {
            if (line === ".") {
              data = false;
              socket.write("250 accepted\r\n");
            } else message += `${line}\n`;
          } else if (line.startsWith("EHLO") || line.startsWith("HELO"))
            socket.write("250 relay.example\r\n");
          else if (line === "DATA") {
            data = true;
            socket.write("354 send message\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 OK\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No SMTP port");
    const output = vi.spyOn(console, "info");
    try {
      const mailer = createMailer({
        kind: "smtp",
        url: `smtp://127.0.0.1:${String(address.port)}`,
        from: "relay@sender.example",
      });
      await mailer({ email: "recipient@example.com", code: "123456" });
      expect(message).toContain("Your sign-in code is 123456");
      expect(message).toContain("To: recipient@example.com");
      expect(output).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
      server.close();
      await once(server, "close");
    }
  });
});
