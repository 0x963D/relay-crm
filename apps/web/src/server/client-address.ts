import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

declare global {
  var relayConnections: AsyncLocalStorage<string> | undefined;
}

// Next can bundle this module more than once in the same server process.
export const connections = (globalThis.relayConnections ??= new AsyncLocalStorage<string>());

function canonicalAddress(value: string): string | null {
  const address = value.trim().toLowerCase();
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return null;
  const mapped = address.replace(/^::ffff:/, "");
  return isIP(mapped) === 4 ? mapped : new URL(`http://[${address}]/`).hostname;
}

export function clientAddress(request: Request, trustedProxyCount: number): string {
  const peer = canonicalAddress(connections.getStore() ?? "") ?? "unknown";
  if (trustedProxyCount === 0) return peer;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",");
  if (!forwarded || forwarded.length < trustedProxyCount) return peer;
  return canonicalAddress(forwarded[forwarded.length - trustedProxyCount] ?? "") ?? peer;
}
