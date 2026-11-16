import { redirect } from "next/navigation";
import { requireSession, getQueryClient, trpc } from "@/lib/trpc/server";
import { homeFor, isLeadManager } from "@/lib/workspace";
import { Empty } from "@/components/pieces";
export default async function AgentsPage() {
  const { profile } = await requireSession();
  if (!isLeadManager(profile.role)) redirect(homeFor(profile.role));
  const agents = await getQueryClient().query(trpc.leads.agents.queryOptions({ offset: 0 }));
  if (agents[0]) redirect(`/agents/${agents[0].ownerId}`);
  return (
    <Empty icon="queue" title="No agent queue to open">
      An agent's queue appears here when they join a sales team.
    </Empty>
  );
}
