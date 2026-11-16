import { getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { AccountsScreen, AccountDetail } from "@/components/accounts";
import { PaymentForm } from "@/components/payment-form";
import { ReadResult } from "@/components/read-result";
export default async function EditPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { zone } = await requireSession();
  const payment = await getQueryClient().query(trpc.payments.get.queryOptions({ id }));
  const query = getQueryClient().query(trpc.accounts.get.queryOptions({ id: payment.accountId }));
  return (
    <ReadResult query={query} back="/payments" title="This payment is unavailable">
      <AccountsScreen selected={payment.accountId}>
        <AccountDetail id={payment.accountId} zone={zone}>
          <PaymentForm accountId={payment.accountId} zone={zone} mode="manual" editing={payment} />
        </AccountDetail>
      </AccountsScreen>
    </ReadResult>
  );
}
