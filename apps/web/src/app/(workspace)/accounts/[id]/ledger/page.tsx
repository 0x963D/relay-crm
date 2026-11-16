import { getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { AccountsScreen, AccountDetail } from "@/components/accounts";
import { ReadResult } from "@/components/read-result";
export default async function LedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { zone } = await requireSession();
  const query = Promise.all([
    getQueryClient().query(trpc.accounts.get.queryOptions({ id })),
    getQueryClient().query(trpc.accounts.ledger.queryOptions({ id })),
  ]);
  return (
    <ReadResult query={query} back="/accounts" title="This ledger is unavailable">
      <AccountsScreen selected={id}>
        <AccountDetail id={id} zone={zone} ledger />
      </AccountsScreen>
    </ReadResult>
  );
}
