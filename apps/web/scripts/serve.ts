import { createServer } from "node:http";
import "../src/server/connection-context.ts";
import { serverOptions } from "../src/server/env.ts";
import { logToConsole } from "../src/server/log.ts";

const { dev, port, host } = serverOptions();
const { default: next } = await import("next");
const app = next({ dev, port });
await app.prepare();
const handle = app.getRequestHandler();
createServer((request, response) => {
  void handle(request, response);
}).listen(port, host, () => {
  logToConsole("server.ready", { port, host });
});
