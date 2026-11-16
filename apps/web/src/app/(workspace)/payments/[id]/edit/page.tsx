import { getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { PaymentsScreen } from "@/components/payments";
import { PaymentForm } from "@/components/payment-form";
import { ReadResult } from "@/components/read-result";
export default async function EditPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { zone } = await requireSession();
  const payment = await getQueryClient().query(trpc.payments.get.queryOptions({ id }));
  const query = getQueryClient().query(trpc.accounts.get.queryOptions({ id: payment.accountId }));
  return (
    <ReadResult query={query} back="/payments" title="This payment is unavailable">
      <PaymentsScreen zone={zone} form>
        <div className="p-4 md:p-6">
          <PaymentForm accountId={payment.accountId} zone={zone} mode="manual" editing={payment} />
        </div>
      </PaymentsScreen>
    </ReadResult>
  );
}
