import { createHmac } from "node:crypto";

export const APP_SECRET = "test-app-secret";
export const VERIFY_TOKEN = "test-verify-token";
export const ACCESS_TOKEN = "test-access-token";
export const WEBHOOK_URL = "https://crm.example/api/intake/meta";

/**
 * A delivery captured as bytes, with the signature `openssl dgst -sha256 -hmac test-app-secret`
 * prints for them. It pins the algorithm to a value this code did not compute.
 */
export const SIGNED_FIXTURE = {
  leadgenId: "444555666777",
  body: '{"object":"page","entry":[{"id":"1029384756","time":1763107200,"changes":[{"field":"leadgen","value":{"leadgen_id":"444555666777","page_id":"1029384756","form_id":"998877665544","created_time":1763107200}}]}]}',
  signature: "sha256=4f715eaeea1f7181f5221657d3a87cc647eeaa36484b9ed8f4ccb465eb2fee16",
} as const;

/** `openssl dgst -sha256 -hmac test-app-secret` over `test-access-token`. */
export const APPSECRET_PROOF = "c7a7a56a58d03b05def128144d755b6c5bd4ba6b88fbfd8a59a909c862e52d7b";

export function sign(body: string | Uint8Array, secret: string = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function notification(...changes: readonly { field: string; value: unknown }[]): string {
  return JSON.stringify({ object: "page", entry: [{ id: "1029384756", time: 1, changes }] });
}

export function leadgen(leadgenId: string): { field: string; value: unknown } {
  return { field: "leadgen", value: { leadgen_id: leadgenId, page_id: "1", form_id: "2" } };
}

export function delivery(
  body: string | Uint8Array<ArrayBuffer>,
  signature: string | null,
): Request {
  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: signature === null ? {} : { "x-hub-signature-256": signature },
    body,
  });
}

export function signedDelivery(body: string): Request {
  return delivery(body, sign(body));
}

export function graphLead(
  id: string,
  answers: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  return {
    id,
    created_time: "2026-11-14T08:00:00+0000",
    field_data: Object.entries(answers).map(([name, value]) => ({ name, values: [value] })),
    ...extra,
  };
}

export function graphFake(leads: Readonly<Record<string, unknown>>): {
  readonly fetch: typeof fetch;
  readonly requests: Request[];
} {
  const requests: Request[] = [];
  return {
    requests,
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
      const body: unknown = Object.hasOwn(leads, id)
        ? leads[id]
        : { error: { message: "Unsupported get request.", code: 100, error_subcode: 33 } };
      return Promise.resolve(Response.json(body, { status: Object.hasOwn(leads, id) ? 200 : 400 }));
    },
  };
}
