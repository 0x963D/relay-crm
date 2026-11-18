import { Server, IncomingMessage } from "node:http";
import { connections } from "./client-address.ts";

// The generated standalone server needs the socket peer before Next handles the request.
// eslint-disable-next-line @typescript-eslint/unbound-method -- Dispatch supplies each server as the receiver.
const emit = Server.prototype.emit;
Server.prototype.emit = function (
  this: Server,
  event: string | symbol,
  ...args: unknown[]
): boolean {
  const request = args[0];
  const dispatch = () => Reflect.apply(emit, this, [event, ...args]) === true;
  return event === "request" && request instanceof IncomingMessage
    ? connections.run(request.socket.remoteAddress ?? "", dispatch)
    : dispatch();
};
globalThis.relayCapturesSocketPeer = true;
