import type { ReactNode } from "react";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { requireSession, getQueryClient, trpc } from "@/lib/trpc/server";
import { homeFor, isLeadManager } from "@/lib/workspace";
import { QueueScreen } from "./queue";
import { ReadResult } from "./read-result";
import { Loading } from "./pieces";
export async function QueueRoute({ agentId, children }: { agentId?: string; children: ReactNode }) {
  const { profile, zone } = await requireSession();
  if (profile.role === "accountant") redirect(homeFor(profile.role));
  if (agentId && !isLeadManager(profile.role)) redirect("/queue");
  const owner = agentId ?? profile.userId;
  const client = getQueryClient();
  const query = client.query(trpc.leads.queue.queryOptions({ agentId: owner, limit: 20 }));
  if (isLeadManager(profile.role))
    void client.query(trpc.leads.agents.queryOptions({ offset: 0 })).catch(() => undefined);
  return (
    <Suspense fallback={<Loading label="Loading queue" />}>
      <ReadResult query={query} title="You cannot open this queue" back={homeFor(profile.role)}>
        <QueueScreen
          profile={profile}
          agentId={owner}
          zone={zone}
          basePath={agentId ? `/agents/${agentId}` : "/queue"}
        >
          {children}
        </QueueScreen>
      </ReadResult>
    </Suspense>
  );
}
