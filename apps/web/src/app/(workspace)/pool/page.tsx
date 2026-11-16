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
  void client.query(trpc.leads.pool.queryOptions({ limit: 14, offset: 0 })).catch(() => undefined);
  void client.query(trpc.leads.agents.queryOptions({ offset: 0 })).catch(() => undefined);
  return (
    <HydrateClient>
      <Suspense fallback={<Loading label="Loading pool" />}>
        <PoolScreen zone={zone} />
      </Suspense>
    </HydrateClient>
  );
}
