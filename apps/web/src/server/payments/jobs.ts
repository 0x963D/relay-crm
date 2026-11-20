import type { Store } from "@relay/store";
import type { PaymentProvider } from "@relay/domain";
import type { createReceiptMailer } from "../mailer.ts";
import { rateLimited } from "../rate-limit.ts";
import { reconcilePayments } from "./reconcile.ts";

export async function runReconcile(store: Store, provider: PaymentProvider, intervalMs: number) {
  const run = await store.exclusiveJob("reconcile", (signal) =>
    reconcilePayments(store, provider, intervalMs, new Date(), signal),
  );
  if (!run.ran) return rateLimited();
  const results = run.result;
  return Response.json({
    checked: results.length,
    changed: results.filter((r) => r.changed).length,
  });
}

export async function runOutbox(store: Store, deliver: ReturnType<typeof createReceiptMailer>) {
  const run = await store.exclusiveJob("outbox", (signal) => store.runOutbox(deliver, { signal }));
  if (!run.ran) return rateLimited();
  const results = run.result;
  return Response.json({
    processed: results.length,
    recordingFailed: results.filter((r) => r.state === "recordingFailed").length,
    superseded: results.filter((r) => r.state === "superseded").length,
    sent: results.filter((r) => r.state === "sent").length,
    failed: results.filter((r) => r.state === "failed").length,
    suppressed: results.filter((r) => r.state === "suppressed").length,
    unknown: results.filter((r) => r.state === "unknown").length,
  });
}
