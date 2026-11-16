import { openStore } from "@relay/store";
import { readEnv } from "../src/server/env.ts";
import { sandboxProvider } from "../src/server/payments/sandbox.ts";
import { reconcilePayments } from "../src/server/payments/reconcile.ts";
const env = readEnv();
if (!env.payments) throw new Error("Sandbox payments are disabled.");
const store = openStore({ connectionString: env.databaseUrl });
try {
  process.stdout.write(
    JSON.stringify(
      await reconcilePayments(store, sandboxProvider(store, env.payments), env.payments.intervalMs),
    ) + "\n",
  );
} finally {
  await store.close();
}
