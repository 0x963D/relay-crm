import { Suspense } from "react";
import { getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { PaymentsScreen } from "@/components/payments";
import { PaymentDetail } from "@/components/payment-detail";
import { Loading } from "@/components/pieces";
import { ReadResult } from "@/components/read-result";
export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { zone } = await requireSession();
  const client = getQueryClient();
  const query = client.query(trpc.payments.get.queryOptions({ id }));
  void client
    .query(trpc.payments.list.queryOptions({ limit: 20, offset: 0 }))
    .catch(() => undefined);
  return (
    <ReadResult
      query={query}
      back="/payments"
      title="This payment is unavailable"
      missingIsNotFound
    >
      <PaymentsScreen zone={zone} selected={id}>
        <Suspense fallback={<Loading label="Loading payment" />}>
          <PaymentDetail key={id} id={id} zone={zone} />
        </Suspense>
      </PaymentsScreen>
    </ReadResult>
  );
}
