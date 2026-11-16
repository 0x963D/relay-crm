import { getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { AccountsScreen, AccountDetail } from "@/components/accounts";
import { PaymentForm } from "@/components/payment-form";
import { ReadResult } from "@/components/read-result";
export default async function PaymentFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { zone } = await requireSession();
  const query = getQueryClient().query(trpc.accounts.get.queryOptions({ id }));
  return (
    <ReadResult query={query} back="/accounts" title="This account is unavailable">
      <AccountsScreen selected={id}>
        <AccountDetail id={id} zone={zone}>
          <PaymentForm accountId={id} mode="manual" zone={zone} />
        </AccountDetail>
      </AccountsScreen>
    </ReadResult>
  );
}
