import { getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { PaymentsScreen } from "@/components/payments";
import { PaymentForm } from "@/components/payment-form";
import { ReadResult } from "@/components/read-result";
export default async function PaymentFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { zone } = await requireSession();
  const query = getQueryClient().query(trpc.accounts.get.queryOptions({ id }));
  return (
    <ReadResult query={query} back="/accounts" title="This account is unavailable">
      <PaymentsScreen zone={zone} form>
        <div className="p-4 md:p-6">
          <PaymentForm accountId={id} mode="manual" zone={zone} />
        </div>
      </PaymentsScreen>
    </ReadResult>
  );
}
