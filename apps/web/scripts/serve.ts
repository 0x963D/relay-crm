import { createServer } from "node:http";
import { connections } from "../src/server/client-address.ts";
import { serverOptions } from "../src/server/env.ts";
import { logToConsole } from "../src/server/log.ts";

const { dev, port } = serverOptions();
const { default: next } = await import("next");
const app = next({ dev, port });
await app.prepare();
const handle = app.getRequestHandler();
createServer((request, response) => {
  connections.run(request.socket.remoteAddress ?? "", () => {
    void handle(request, response);
  });
}).listen(port, () => {
  logToConsole("server.ready", { port });
});
