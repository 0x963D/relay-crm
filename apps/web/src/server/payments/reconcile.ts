import type { PaymentProvider, ProviderPayment } from "@relay/domain";
import type { Store } from "@relay/store";

export async function reconcilePayments(
  store: Store,
  provider: PaymentProvider,
  intervalMs: number,
  at = new Date(),
) {
  const candidates = await store.duePayments(at, 100);
  const results = [];
  for (const { id } of candidates) {
    const token = await store.claimPaymentCheck(id, at, intervalMs);
    if (token === null) continue;
    let observed: ProviderPayment | null;
    try {
      observed = await provider.readPayment(id);
    } catch {
      observed = null;
    }
    results.push({ id, ...(await store.finishPaymentCheck(id, token, observed)) });
  }
  return results;
}
