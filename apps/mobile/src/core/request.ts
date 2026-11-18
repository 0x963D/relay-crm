import { mapFailure, RequestFailure } from "./failure.ts";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function createRequester(options: {
  readonly fetch: Fetch;
  readonly token: () => string | null;
  readonly sessionEnded: () => void;
  readonly timeoutMs?: number | null;
}): Fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
    };
    init?.signal?.addEventListener("abort", cancel);
    if (init?.signal?.aborted) cancel();
    const headers = new Headers(init?.headers);
    headers.delete("origin");
    headers.delete("cookie");
    headers.delete("authorization");
    const token = options.token();
    if (token) headers.set("authorization", `Bearer ${token}`);
    let status: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      if (options.timeoutMs === null) return;
      timer = setTimeout(() => {
        reject(new RequestFailure(mapFailure({ status, timedOut: true })));
        controller.abort();
      }, options.timeoutMs ?? 20000);
    });
    try {
      return await Promise.race([
        (async () => {
          try {
            const response = await options.fetch(input, {
              ...init,
              headers,
              credentials: "omit",
              signal: controller.signal,
            });
            status = response.status;
            if (status === 401 && token !== null && token === options.token())
              options.sessionEnded();
            const body = await response.arrayBuffer();
            return new Response([204, 205, 304].includes(status) ? null : body, {
              status,
              statusText: response.statusText,
              headers: response.headers,
            });
          } catch {
            throw new RequestFailure(mapFailure({ status }));
          }
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", cancel);
    }
  };
}
