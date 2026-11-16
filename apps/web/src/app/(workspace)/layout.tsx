import type { ReactNode } from "react";
import { requireSession, getQueryClient, trpc, HydrateClient } from "@/lib/trpc/server";
import { isLeadManager } from "@/lib/workspace";
import { Workspace } from "@/components/workspace";
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { profile, demo } = await requireSession();
  const client = getQueryClient();
  void client
    .query(trpc.accounts.list.queryOptions({ limit: 20, offset: 0 }))
    .catch(() => undefined);
  void client
    .query(trpc.payments.list.queryOptions({ limit: 20, offset: 0 }))
    .catch(() => undefined);
  if (isLeadManager(profile.role)) {
    void client
      .query(trpc.leads.pool.queryOptions({ limit: 14, offset: 0 }))
      .catch(() => undefined);
    void client.query(trpc.leads.agents.queryOptions({ offset: 0 })).catch(() => undefined);
  } else if (profile.role === "agent") {
    void client
      .query(trpc.leads.queue.queryOptions({ agentId: profile.userId, limit: 20 }))
      .catch(() => undefined);
  }
  return (
    <HydrateClient>
      <Workspace profile={profile} demo={demo}>
        {children}
      </Workspace>
    </HydrateClient>
  );
}
