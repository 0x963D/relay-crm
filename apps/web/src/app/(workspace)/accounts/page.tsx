import { HydrateClient, getQueryClient, requireSession, trpc } from "@/lib/trpc/server";
import { AccountsScreen } from "@/components/accounts";
export default async function AccountsPage() {
  await requireSession();
  await getQueryClient().query(trpc.accounts.list.queryOptions({ limit: 20, offset: 0 }));
  return (
    <HydrateClient>
      <AccountsScreen />
    </HydrateClient>
  );
}
