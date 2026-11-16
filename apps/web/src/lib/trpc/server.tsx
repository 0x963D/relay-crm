import "server-only";
import { cache, type ReactNode } from "react";
import { connection } from "next/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { resolvePrincipal } from "@/server/actor";
import { composition } from "@/server/composition";
import { appRouter } from "@/server/rpc";
import { makeQueryClient } from "./query-client";
export const getQueryClient = cache(makeQueryClient);
const getContext = cache(async () => {
  await connection();
  const app = composition();
  return {
    store: app.store,
    principal: await resolvePrincipal(app, await headers()),
    timeZone: app.env.timeZone,
  };
});
export const trpc = createTRPCOptionsProxy({
  ctx: getContext,
  router: appRouter,
  queryClient: getQueryClient,
});
export const getSession = cache(async () => {
  const ctx = await getContext();
  if (!ctx.principal) return null;
  const profile = await getQueryClient().query(trpc.session.profile.queryOptions());
  return { profile, zone: ctx.timeZone, demo: composition().env.demo };
});
export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session;
}
export function HydrateClient({ children }: { children: ReactNode }) {
  return <HydrationBoundary state={dehydrate(getQueryClient())}>{children}</HydrationBoundary>;
}
