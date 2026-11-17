import type { ReactNode } from "react";
import { requireSession, getQueryClient, trpc, HydrateClient } from "@/lib/trpc/server";
import { isLeadManager } from "@/lib/workspace";
import { Workspace } from "@/components/workspace";
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { profile, demo } = await requireSession();
  const client = getQueryClient();
  const reads: Promise<unknown>[] = [
    client.query(trpc.accounts.list.queryOptions({ limit: 20, offset: 0 })),
    client.query(trpc.payments.list.queryOptions({ limit: 20, offset: 0 })),
  ];
  if (isLeadManager(profile.role)) {
    reads.push(
      client.query(trpc.leads.pool.queryOptions({ limit: 14, offset: 0 })),
      client.query(trpc.leads.agents.queryOptions({ offset: 0 })),
    );
  } else if (profile.role === "agent") {
    reads.push(client.query(trpc.leads.queue.queryOptions({ agentId: profile.userId, limit: 20 })));
  }
  await Promise.allSettled(reads);
  return (
    <HydrateClient>
      <Workspace profile={profile} demo={demo}>
        {children}
      </Workspace>
    </HydrateClient>
  );
}
