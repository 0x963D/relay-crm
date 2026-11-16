"use client";
import { type ReactNode, useState } from "react";
import { environmentManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createApi } from "@/lib/api";
import { TRPCProvider } from "@/lib/trpc/client";
import { makeQueryClient } from "@/lib/trpc/query-client";
let browserClient: QueryClient | undefined;
function getQueryClient() {
  if (environmentManager.isServer()) return makeQueryClient();
  return (browserClient ??= makeQueryClient());
}
export function DataProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(createApi);
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
