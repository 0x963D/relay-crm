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
  // The URL parser gives each address one spelling, and a mapped IPv4 address two hex groups.
  const spelling = new URL(`http://[${address}]/`).hostname;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(spelling);
  if (!mapped) return spelling;
  const [high, low] = [parseInt(mapped[1] ?? "", 16), parseInt(mapped[2] ?? "", 16)];
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
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
