declare const __DEV__: boolean;

const configured: unknown = process.env.EXPO_PUBLIC_RELAY_URL;

export function serverOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Set EXPO_PUBLIC_RELAY_URL to an HTTP or HTTPS origin.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const parts = host.split(".").map(Number);
  const [a, b] = parts;
  const privateV4 =
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (a === 127 ||
      a === 10 ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168));
  const local =
    host === "localhost" || host === "::1" || privateV4 || /^f[cd][a-f\d]{2}:/.test(host);
  if (url.protocol === "http:" && !local)
    throw new Error(
      "EXPO_PUBLIC_RELAY_URL requires HTTPS except on loopback, 10.0.2.2 or a private network address.",
    );
  return url.origin;
}

export function configuredServer(value: unknown, development: boolean): string {
  if (typeof value === "string" && value.trim()) return serverOrigin(value);
  if (!development) throw new Error("Set EXPO_PUBLIC_RELAY_URL before building the app.");
  return serverOrigin("http://10.0.2.2:3107");
}
export const server = configuredServer(configured, typeof __DEV__ !== "undefined" && __DEV__);
