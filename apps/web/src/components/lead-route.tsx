import { Suspense } from "react";
import { requireSession, getQueryClient, trpc } from "@/lib/trpc/server";
import { homeFor } from "@/lib/workspace";
import { LeadDetail } from "./lead-detail";
import { ReadResult } from "./read-result";
import { Loading } from "./pieces";
export async function LeadRoute({ id }: { id: string }) {
  const { profile, zone } = await requireSession();
  const query = getQueryClient().query(trpc.leads.get.queryOptions({ id }));
  return (
    <Suspense fallback={<Loading label="Loading lead" />}>
      <ReadResult query={query} title="You cannot open this lead" back={homeFor(profile.role)}>
        <LeadDetail key={id} id={id} profile={profile} zone={zone} />
      </ReadResult>
    </Suspense>
  );
}
