import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const raw: unknown = JSON.parse(await readFile("/run/relay-secrets/jobs.json", "utf8"));
const jobs = z
  .object({ origin: z.url(), reconcile: z.string(), outbox: z.string(), reset: z.string() })
  .parse(raw);
async function call(job: "reconcile" | "outbox" | "reset") {
  const path = job === "reset" ? "/api/demo/reset" : `/api/payments/${job}`;
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
if (process.argv.includes("--reset")) {
  if (!(await call("reset"))) process.exitCode = 1;
} else {
  let resetDay = new Date().toISOString().slice(0, 10);
  for (;;) {
    await sleep(60000 - (Date.now() % 60000));
    const today = new Date().toISOString().slice(0, 10);
    if (today !== resetDay) {
      if (await call("reset")) resetDay = today;
    } else {
      await call("reconcile");
      await call("outbox");
    }
  }
}
