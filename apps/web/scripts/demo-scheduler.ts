import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const raw: unknown = JSON.parse(await readFile("/run/relay-secrets/jobs/config.json", "utf8"));
const jobs = z.object({ origin: z.url(), reconcile: z.string(), outbox: z.string() }).parse(raw);
async function call(job: "reconcile" | "outbox") {
  const path = `/api/payments/${job}`;
  try {
    const response = await fetch(`${jobs.origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${jobs[job]}` },
      signal: AbortSignal.timeout(55000),
    });
    process.stdout.write(`demo.job ${JSON.stringify({ path, status: response.status })}\n`);
    return response.ok;
  } catch {
    process.stdout.write(`demo.job ${JSON.stringify({ path, failed: true })}\n`);
    return false;
  }
}
for (;;) {
  await sleep(60000 - (Date.now() % 60000));
  await call("reconcile");
  await call("outbox");
}
