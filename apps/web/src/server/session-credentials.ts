type SessionCredentials =
  | { readonly kind: "cookie" }
  | { readonly kind: "none" }
  | { readonly kind: "refused" }
  | { readonly kind: "bearer"; readonly token: string | null };

export function sessionCredentials(headers: Headers): SessionCredentials {
  if (!headers.has("authorization")) return { kind: headers.has("cookie") ? "cookie" : "none" };
  if (headers.has("cookie") || headers.has("origin")) return { kind: "refused" };
  const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(headers.get("authorization") ?? "")?.[1];
  return { kind: "bearer", token: token ?? null };
}
