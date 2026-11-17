import { HydrateClient, getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { PaymentsScreen } from "@/components/payments";
export default async function PaymentsPage() {
  const { zone } = await requireSession();
  await getQueryClient().query(trpc.payments.list.queryOptions({ limit: 20, offset: 0 }));
  return (
    <HydrateClient>
      <PaymentsScreen zone={zone} />
    </HydrateClient>
  );
}
