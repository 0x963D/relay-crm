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

export class ClientAddressError extends Error {
  override readonly name = "ClientAddressError";
}

export function clientAddress(request: Request, trustedProxyCount: number): string {
  const peer = canonicalAddress(connections.getStore() ?? "");
  const forwarded = request.headers.get("x-forwarded-for")?.split(",");
  const trusted =
    trustedProxyCount > 0 && forwarded && forwarded.length >= trustedProxyCount
      ? canonicalAddress(forwarded[forwarded.length - trustedProxyCount] ?? "")
      : null;
  const address = trusted ?? peer;
  if (address === null)
    throw new ClientAddressError(
      "No client address. Use the HTTP entry point or configure a trusted proxy.",
    );
  return address;
}
