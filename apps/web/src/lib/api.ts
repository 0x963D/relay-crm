import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/rpc";
export type Inputs = inferRouterInputs<AppRouter>;
export type Outputs = inferRouterOutputs<AppRouter>;
export const createApi = () =>
  createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        async fetch(url, options) {
          const response = await fetch(url, { ...options, signal: options?.signal ?? null });
          if (response.status >= 500)
            throw TRPCClientError.from<AppRouter>(new Error("Server request failed"), {
              meta: { response },
            });
          return response;
        },
      }),
    ],
  });
