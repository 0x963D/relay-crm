import "../src/server/connection-context.ts";
import { connections } from "../src/server/client-address.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";

test("HTTP handling keeps the socket peer across awaits and ignores a forged forwarded address", async () => {
  const server = createServer((request, response) => {
    void sleep(5).then(() => {
      response.end(connections.getStore());
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No HTTP listener");
    const replies = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(`http://127.0.0.1:${String(address.port)}`, {
          headers: { "x-forwarded-for": "203.0.113.1" },
        }).then((response) => response.text()),
      ),
    );
    expect(replies).toEqual(["127.0.0.1", "127.0.0.1", "127.0.0.1"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
});
