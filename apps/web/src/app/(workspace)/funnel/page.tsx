import { getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { ReadResult } from "@/components/read-result";
import { FunnelScreen } from "@/components/funnel";
export default async function FunnelPage() {
  await requireSession();
  const query = getQueryClient().query(trpc.reports.funnel.queryOptions());
  return (
    <ReadResult
      query={query}
      back="/accounts"
      title="This report is unavailable"
      accessMessage="Your role cannot open the campaign funnel."
    >
      <FunnelScreen />
    </ReadResult>
  );
}
