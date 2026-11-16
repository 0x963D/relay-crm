import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireSession, getQueryClient, trpc, HydrateClient } from "@/lib/trpc/server";
import { homeFor, isLeadManager } from "@/lib/workspace";
import { PoolScreen } from "@/components/pool";
import { Loading } from "@/components/pieces";
export default async function PoolPage() {
  const { profile, zone } = await requireSession();
  if (!isLeadManager(profile.role)) redirect(homeFor(profile.role));
  const client = getQueryClient();
  await Promise.all([
    client.query(trpc.leads.pool.queryOptions({ limit: 14, offset: 0 })),
    client.query(trpc.leads.agents.queryOptions({ offset: 0 })),
  ]);
  return (
    <HydrateClient>
      <Suspense fallback={<Loading label="Loading pool" />}>
        <PoolScreen zone={zone} />
      </Suspense>
    </HydrateClient>
  );
}
