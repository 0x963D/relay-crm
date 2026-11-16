import { notFound } from "next/navigation";
import { getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { PaymentsScreen } from "@/components/payments";
import { PaymentForm } from "@/components/payment-form";
import { ReadResult } from "@/components/read-result";

export default async function NewPaymentPage({
  params,
}: {
  params: Promise<{ accountId: string; method: string }>;
}) {
  const { accountId, method } = await params;
  if (method !== "card" && method !== "manual") notFound();
  const { zone } = await requireSession();
  const query = getQueryClient().query(trpc.accounts.get.queryOptions({ id: accountId }));
  return (
    <ReadResult query={query} back="/accounts" title="This account is unavailable">
      <PaymentsScreen zone={zone} form>
        <div className="p-4 md:p-6">
          <PaymentForm accountId={accountId} mode={method} zone={zone} />
        </div>
      </PaymentsScreen>
    </ReadResult>
  );
}
