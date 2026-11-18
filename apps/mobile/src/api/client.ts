import { createTRPCClient, httpLink, TRPCClientError } from "@trpc/client";
import type { AppRouter } from "@relay/web/api-types";
import superjson from "superjson";
import { z } from "zod";
import { server } from "./server.ts";
import { bearer } from "./token.ts";
import { credentialSchema } from "../core/session.ts";
import { mapFailure, RequestFailure, retrySeconds } from "../core/failure.ts";
import { createRequester } from "../core/request.ts";
import { readShapes } from "../core/read-shapes.ts";
import { receiptSchema } from "../core/write-model.ts";
import type { Fetch } from "../core/request.ts";

let onSessionEnded: (() => void) | null = null;
export function setSessionEnded(handler: (() => void) | null) {
  onSessionEnded = handler;
}
const errorData = z.object({
  httpStatus: z.number(),
  code: z.string(),
  accessFailure: z.string().nullable().optional(),
});
export function failureFrom(error: unknown) {
  if (error instanceof RequestFailure) return error.failure;
  if (error instanceof TRPCClientError) {
    if (error.cause instanceof RequestFailure) return error.cause.failure;
    const response = z.object({ response: z.object({ status: z.number() }) }).safeParse(error.meta);
    const parsed = errorData.safeParse(error.data);
    return mapFailure({
      status: response.success ? response.data.response.status : parsed.data?.httpStatus,
      code: parsed.data?.code,
      accessFailure: parsed.data?.accessFailure,
      api: parsed.success,
    });
  }
  return mapFailure({});
}
export async function read<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RequestFailure(failureFrom(error));
  }
}

export function createClient(options: {
  origin: string;
  fetch: Fetch;
  token: () => string | null;
  sessionEnded: () => void;
  timeoutMs?: number;
}) {
  const request = createRequester(options);
  const writeRequest = createRequester({ ...options, timeoutMs: null });
  const rpc = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: `${options.origin}/api/trpc`,
        transformer: superjson,
        fetch: async (input, init) => {
          const address =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const route = address.split("?")[0]?.split("/").at(-1) ?? "";
          const writing = [
            "leads.logAttempt",
            "leads.addNote",
            "leads.setCallback",
            "leads.close",
          ].includes(route);
          const response = await (writing ? writeRequest : request)(input, {
            ...init,
            signal: init?.signal ?? null,
          });
          try {
            if (response.status >= 500)
              throw new RequestFailure(mapFailure({ status: response.status }));
            const body: unknown = await response
              .clone()
              .json()
              .catch(() => null);
            const envelope = z
              .union([
                z.object({ result: z.object({ data: z.object({ json: z.unknown() }).loose() }) }),
                z.object({
                  error: z.object({
                    json: z.object({ message: z.string(), code: z.number(), data: errorData }),
                  }),
                }),
              ])
              .safeParse(body);
            if (!envelope.success)
              throw new RequestFailure(mapFailure({ status: response.status }));
            if ("result" in envelope.data) {
              if (!response.ok) throw new RequestFailure(mapFailure({ status: response.status }));
              const decoded = superjson.parse(JSON.stringify(envelope.data.result.data));
              const shape = writing ? receiptSchema : readShapes.get(route);
              if (!shape?.safeParse(decoded).success)
                throw new RequestFailure(mapFailure({ status: response.status }));
            }
            return response;
          } catch (error) {
            if (error instanceof RequestFailure) throw error;
            throw new RequestFailure(mapFailure({ status: response.status }));
          }
        },
      }),
    ],
  });
  const errorBody = z.object({ code: z.string() });
  async function native<T>(route: string, body: object, schema: z.ZodType<T>): Promise<T> {
    const response = await request(`${options.origin}/api/auth/native/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok)
      throw new RequestFailure(
        mapFailure({ status: response.status, api: errorBody.safeParse(data).success }),
        errorBody.safeParse(data).data?.code,
        retrySeconds(response.headers.get("retry-after")),
      );
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new RequestFailure(mapFailure({ status: response.status }));
    return parsed.data;
  }
  const success = z.object({ success: z.literal(true) });
  return {
    rpc,
    auth: {
      async sendCode(email: string) {
        await native("send-code", { email }, success);
      },
      signIn(email: string, otp: string) {
        return native("sign-in", { email, otp }, credentialSchema);
      },
      demo() {
        return native("demo", { role: "agent" }, credentialSchema);
      },
      async signOut() {
        try {
          await native("sign-out", {}, success);
        } catch (error) {
          const failure = failureFrom(error);
          if (
            failure.kind !== "sessionEnded" &&
            !(failure.kind === "http" && failure.status === 401)
          )
            throw error;
        }
      },
      async verify() {
        const token = options.token();
        const response = await request(`${options.origin}/api/auth/get-session`);
        if (!response.ok) throw new RequestFailure(mapFailure({ status: response.status }));
        const data: unknown = await response.json().catch(() => undefined);
        if (data === null) {
          if (token === options.token()) options.sessionEnded();
          throw new RequestFailure({ kind: "sessionEnded", status: response.status });
        }
        if (
          !z
            .object({
              user: z.object({ id: z.string() }),
              session: z.object({ expiresAt: z.string() }),
            })
            .safeParse(data).success
        )
          throw new RequestFailure(mapFailure({ status: response.status }));
      },
    },
  };
}
export const { rpc, auth } = createClient({
  origin: server,
  fetch,
  token: bearer,
  sessionEnded: () => onSessionEnded?.(),
});
