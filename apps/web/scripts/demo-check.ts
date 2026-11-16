import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import superjson from "superjson";
import { createRequire } from "node:module";
import { commandEnvironment } from "../src/server/env.ts";
import { z } from "zod";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const argument = process.argv[2];
if (!argument || argument.startsWith("--"))
  throw new Error("Pass a directory outside the repository for demo evidence.");
const directory = resolve(argument);
assert(!directory.startsWith(root), "Evidence must stay outside the repository.");
await mkdir(directory, { recursive: true });
const execute = promisify(execFile);
const docker = (args: string[]) =>
  execute("docker", args, { cwd: root, maxBuffer: 5 * 1024 * 1024 });
const rawConfiguration: unknown = JSON.parse(
  (await docker(["compose", "config", "--format", "json"])).stdout,
);
const configuration = z
  .object({
    name: z.string(),
    services: z.record(
      z.string(),
      z.object({
        image: z.string().optional(),
        ports: z.array(z.object({ published: z.coerce.number() })).optional(),
      }),
    ),
  })
  .parse(rawConfiguration);
const project = configuration.name;
const composeArgs = ["compose", "-p", project];
const appPort = configuration.services.app?.ports?.[0]?.published;
const mailPort = configuration.services.mail?.ports?.[0]?.published;
assert(appPort && mailPort, "The app and inbox must publish ports.");
const origin = `http://127.0.0.1:${String(appPort)}`;
const inbox = `http://127.0.0.1:${String(mailPort)}`;
assert.equal(
  (
    await docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`])
  ).stdout.trim(),
  "",
  "The selected project is already running.",
);
assert.equal(
  (
    await docker(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`])
  ).stdout.trim(),
  "",
  "The selected project already has volumes. Choose a fresh project name.",
);
for (const port of [appPort, mailPort]) {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) reject(error);
        else resolvePort();
      });
    });
  });
}
const images = [
  ...new Set(
    Object.values(configuration.services).flatMap((service) =>
      service.image?.startsWith(`${project}-`) ? [service.image] : [],
    ),
  ),
];
const priorImages = await Promise.all(
  images.map(async (name) => ({
    name,
    existed: Boolean((await docker(["image", "ls", "-q", name])).stdout.trim()),
  })),
);
if (process.argv.includes("--cold"))
  for (const image of priorImages)
    assert(!image.existed, "A cold check needs a fresh project image name.");
const readme = await readFile(new URL("../../../README.md", import.meta.url), "utf8");
const command = readme
  .split("## Run the demo\n")[1]
  ?.match(/```sh\n([^`]+)```/)?.[1]
  ?.trim();
assert.equal(command, "docker compose up", "Run exactly the README quickstart.");
const log = createWriteStream(resolve(directory, "compose.log"));
const started = performance.now();
const compose = spawn("docker", ["compose", "up"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
compose.stdout.pipe(log, { end: false });
compose.stderr.pipe(log, { end: false });
const processState: { error: Error | null } = { error: null };
compose.on("error", (error) => {
  processState.error = error;
});
const record = (event: string, detail: unknown) =>
  process.stdout.write(`${event} ${JSON.stringify(detail)}\n`);
class DemoRestarting extends Error {}
async function checkReset(response: Response, cookie?: string) {
  if (response.ok) return;
  const health = await fetch(`${origin}/api/health`);
  if (
    health.status === 503 ||
    (cookie &&
      (await fetch(`${origin}/api/trpc/session.current`, { headers: { cookie } })).status === 401)
  )
    throw new DemoRestarting();
}
const resultEnvelope = z.object({ result: z.object({ data: z.unknown() }) });
async function rpc(
  path: string,
  input: unknown,
  cookie: string,
  mutation = false,
): Promise<unknown> {
  const encoded = superjson.serialize(input);
  const response = await fetch(
    `${origin}/api/trpc/${path}${mutation ? "" : `?input=${encodeURIComponent(JSON.stringify(encoded))}`}`,
    {
      method: mutation ? "POST" : "GET",
      headers: { origin, cookie, "content-type": "application/json" },
      ...(mutation ? { body: JSON.stringify(encoded) } : {}),
    },
  );
  await checkReset(response, cookie);
  const text = await response.text();
  assert.equal(response.status, 200, `${path} returned ${String(response.status)} ${text}`);
  const raw: unknown = JSON.parse(text);
  return superjson.parse(JSON.stringify(resultEnvelope.parse(raw).result.data));
}
async function signIn(role: "manager" | "agent" | "accountant") {
  const response = await fetch(`${origin}/api/auth/demo`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  await checkReset(response);
  assert.equal(response.status, 200, `Demo sign-in for ${role}`);
  const body: unknown = await response.json();
  const session = z
    .object({
      user: z.object({ id: z.string(), role: z.literal(role), name: z.string() }),
      roles: z.array(z.string()).length(3),
    })
    .parse(body);
  assert.deepEqual(session.roles, ["manager", "agent", "accountant"]);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert(cookie.includes("relay.session_token="));
  return { ...session.user, cookie };
}
const Counts = z.object({
  overdueCallbacks: z.number(),
  dueToday: z.number(),
  noCallbackSet: z.number(),
  notYetCalled: z.number(),
  later: z.number(),
});
const Ledger = z.object({
  balances: z.array(
    z.object({
      balance: z.bigint(),
      entries: z.array(
        z.object({
          paymentId: z.string(),
          posting: z.object({
            lines: z.array(z.object({ side: z.enum(["debit", "credit"]), amount: z.bigint() })),
          }),
        }),
      ),
    }),
  ),
});
function balanced(ledger: z.infer<typeof Ledger>) {
  for (const entry of ledger.balances.flatMap((balance) => balance.entries)) {
    const debit = entry.posting.lines
      .filter((line) => line.side === "debit")
      .reduce((sum, line) => sum + line.amount, 0n);
    const credit = entry.posting.lines
      .filter((line) => line.side === "credit")
      .reduce((sum, line) => sum + line.amount, 0n);
    assert(debit > 0n);
    assert.equal(debit, credit);
  }
}
async function check() {
  const deadline = performance.now() + 600000;
  let ready = false;
  let nextProgress = performance.now();
  while (performance.now() < deadline) {
    if (processState.error) throw processState.error;
    if (compose.exitCode !== null)
      throw new Error(
        `Compose exited with ${String(compose.exitCode)}. See ${directory}/compose.log`,
      );
    const response = await fetch(`${origin}/api/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (response?.status === 200) {
      assert.equal(await response.text(), "");
      ready = true;
      break;
    }
    if (performance.now() >= nextProgress) {
      record("quickstart.waiting", { seconds: Math.round((performance.now() - started) / 1000) });
      nextProgress += 15000;
    }
    await sleep(1000);
  }
  assert(ready, "The demo did not become healthy.");
  const manager = await signIn("manager");
  const agent = await signIn("agent");
  const accountant = await signIn("accountant");
  const checkQueue = async (cookie: string) => {
    const queue = z
      .object({ at: z.date(), timeZone: z.string(), counts: Counts })
      .parse(await rpc("leads.queue", {}, cookie));
    const clock = new Intl.DateTimeFormat("en-GB", {
      timeZone: queue.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .format(queue.at)
      .split(":")
      .map(Number);
    const seconds =
      (clock[0] ?? 0) * 3600 +
      (clock[1] ?? 0) * 60 +
      (clock[2] ?? 0) +
      queue.at.getMilliseconds() / 1000;
    const passed = Number(seconds > 20 * 3600) + Number(seconds > 22 * 3600);
    assert.deepEqual(queue.counts, {
      overdueCallbacks: 2 + passed,
      dueToday: 2 - passed,
      noCallbackSet: 2,
      notYetCalled: 2,
      later: 2,
    });
    return queue;
  };
  const queue = await checkQueue(agent.cookie);
  const paymentCounts = z
    .object({ counts: z.record(z.string(), z.number()) })
    .parse(await rpc("payments.list", { limit: 100 }, accountant.cookie)).counts;
  await rpc("payments.list", { limit: 100 }, agent.cookie);
  await rpc("payments.list", { limit: 100 }, manager.cookie);
  const accounts = z
    .object({
      total: z.number(),
      items: z.array(
        z.object({ id: z.string(), person: z.object({ name: z.string().nullable() }).nullable() }),
      ),
    })
    .parse(await rpc("accounts.list", { limit: 100 }, accountant.cookie));
  const account = accounts.items.find((account) => account.person?.name === "Jonas Weber");
  assert(account);
  const ledger = Ledger.parse(await rpc("accounts.ledger", { id: account.id }, accountant.cookie));
  balanced(ledger);
  assert.equal(ledger.balances[0]?.balance, 118500n);
  record("QUICKSTART", {
    wallMs: Math.round(performance.now() - started),
    command,
    roles: [manager.name, agent.name, accountant.name],
    queueGroups: queue.counts,
    paymentCounts,
    accounts: accounts.total,
    ledgerBalanceMinor: "118500",
    cold: process.argv.includes("--cold"),
    baseImagesAndBuildCacheMayBeWarm: true,
  });
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  const unauthorized = await fetch(`${origin}/api/demo/reset`, { method: "POST" });
  assert.equal(unauthorized.status, 404);
  const normal = z
    .object({ paymentId: z.string(), checkout: z.object({ url: z.url() }) })
    .parse(
      await rpc(
        "payments.createCheckout",
        {
          key: randomUUID(),
          accountId: account.id,
          amount: "100",
          currency: "GBP",
          kind: "repeat",
        },
        manager.cookie,
        true,
      ),
    );
  const delivery = await fetch(normal.checkout.url, {
    method: "POST",
    headers: { origin },
    body: "mode=normal",
    redirect: "manual",
  });
  assert.equal(delivery.status, 303);
  const webhookDeadline = performance.now() + 15000;
  let webhookArrived = false;
  while (performance.now() < webhookDeadline) {
    const payment = z
      .object({ events: z.array(z.object({ kind: z.string() })), postingCount: z.number() })
      .parse(await rpc("payments.get", { id: normal.paymentId }, accountant.cookie));
    if (payment.events.some((event) => event.kind === "webhookDelivery")) {
      assert.equal(payment.postingCount, 1);
      webhookArrived = true;
      break;
    }
    await sleep(250);
  }
  assert(webhookArrived, "The sandbox webhook did not arrive at the app on this published port.");
  record("LIVE_WEBHOOK", { port: appPort, paymentId: normal.paymentId, postingCount: 1 });
  const checkout = z.object({ paymentId: z.string(), checkout: z.object({ url: z.url() }) }).parse(
    await rpc(
      "payments.createCheckout",
      {
        key: randomUUID(),
        accountId: account.id,
        amount: "12500",
        currency: "GBP",
        kind: "repeat",
        mode: "drop",
      },
      manager.cookie,
      true,
    ),
  );
  const paidAt = performance.now();
  const paid = await fetch(checkout.checkout.url, {
    method: "POST",
    headers: { origin },
    redirect: "manual",
  });
  assert.equal(paid.status, 303);
  const Payment = z.object({
    state: z.object({ status: z.string(), by: z.string().optional() }),
    receipt: z.object({ state: z.string() }).nullable(),
  });
  let recovered = false;
  const recoveryDeadline = performance.now() + 66000;
  while (performance.now() < recoveryDeadline) {
    const current = Payment.parse(
      await rpc("payments.get", { id: checkout.paymentId }, accountant.cookie),
    );
    if (current.state.status === "completed") {
      assert.equal(current.state.by, "reconciler");
      recovered = true;
      break;
    }
    await sleep(1000);
  }
  assert(recovered, "The scheduler did not recover a dropped webhook within its minute interval.");
  record("LIVE_RECOVERY", {
    paymentId: checkout.paymentId,
    completedBy: "reconciler",
    wallMs: Math.round(performance.now() - paidAt),
  });
  const receiptDeadline = performance.now() + 66000;
  let receipt = "";
  while (performance.now() < receiptDeadline && !receipt) {
    const raw: unknown = await (await fetch(`${inbox}/api/v1/messages`)).json();
    const messages = z
      .object({ messages: z.array(z.object({ ID: z.string() })) })
      .parse(raw).messages;
    for (const message of messages) {
      const rawMessage: unknown = await (
        await fetch(`${inbox}/api/v1/message/${message.ID}`)
      ).json();
      const text = z.object({ Text: z.string() }).parse(rawMessage).Text;
      if (text.includes(checkout.paymentId)) {
        receipt = text;
        break;
      }
    }
    if (!receipt) await sleep(1000);
  }
  assert(
    receipt.includes("Received GBP 125.00."),
    "The payment receipt did not reach the mail inbox.",
  );
  record("LIVE_RECEIPT", { paymentId: checkout.paymentId, text: receipt.trim() });
  const reset = await docker([
    ...composeArgs,
    "exec",
    "-T",
    "resetter",
    "node",
    "--import",
    "tsx",
    "apps/web/scripts/demo-reset.ts",
    "--container",
  ]);
  assert(reset.stdout.includes("All sessions ended."), reset.stdout + reset.stderr);
  const ended = await fetch(`${origin}/api/trpc/session.current`, {
    headers: { cookie: agent.cookie },
  });
  assert.equal(ended.status, 401);
  const restoredAccountant = await signIn("accountant");
  const restoredAgent = await signIn("agent");
  const restoredQueue = await checkQueue(restoredAgent.cookie);
  const restoredPayments = z
    .object({ counts: z.record(z.string(), z.number()) })
    .parse(await rpc("payments.list", { limit: 100 }, restoredAccountant.cookie));
  assert.deepEqual(restoredPayments.counts, paymentCounts);
  const restoredAccounts = z
    .object({
      items: z.array(
        z.object({ id: z.string(), person: z.object({ name: z.string().nullable() }).nullable() }),
      ),
    })
    .parse(await rpc("accounts.list", { limit: 100 }, restoredAccountant.cookie));
  const restored = restoredAccounts.items.find((account) => account.person?.name === "Jonas Weber");
  assert(restored);
  const restoredLedger = Ledger.parse(
    await rpc("accounts.ledger", { id: restored.id }, restoredAccountant.cookie),
  );
  balanced(restoredLedger);
  assert.equal(restoredLedger.balances[0]?.balance, 118500n);
  assert(
    !restoredLedger.balances
      .flatMap((balance) => balance.entries)
      .some((entry) => entry.paymentId === checkout.paymentId),
  );
  const removed = await fetch(
    `${origin}/api/trpc/payments.get?input=${encodeURIComponent(JSON.stringify({ json: { id: checkout.paymentId } }))}`,
    { headers: { cookie: restoredAccountant.cookie } },
  );
  assert.equal(removed.status, 403);
  record("LIVE_RESET", {
    sessionsEnded: true,
    visitorPaymentRemoved: true,
    queue: restoredQueue.counts,
    paymentCounts: restoredPayments.counts,
    ledgerBalanceMinor: "118500",
  });
  if (process.argv.includes("--browser")) {
    const fixture = await docker([
      ...composeArgs,
      "exec",
      "-T",
      "resetter",
      "node",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { applyDemoConfiguration } from './apps/web/src/server/env-file.ts';
       import { composition } from './apps/web/src/server/composition.ts';
       import { importCsv } from './apps/web/src/server/intake/csv.ts';
       await applyDemoConfiguration('/run/relay-secrets/reset/config.json');
       const {store} = composition();
       try {
         const csv = ['email,name', ...Array.from({length:25}, (_,i) => 'paging.' + i + '@example.com,Paging ' + i)].join('\\n');
         const report = await importCsv({intake:store.intake, now:()=>new Date()}, csv);
         if (report.failures.length) throw new Error(JSON.stringify(report.failures));
         process.stdout.write(JSON.stringify(report));
       } finally { await store.close(); }`,
    ]);
    record("BROWSER_PAGING_FIXTURE", JSON.parse(fixture.stdout));

    const raw: unknown = JSON.parse(
      (
        await docker([
          ...composeArgs,
          "exec",
          "-T",
          "app",
          "node",
          "-e",
          "process.stdout.write(require('node:fs').readFileSync('/run/relay-secrets/app/config.json','utf8'))",
        ])
      ).stdout,
    );
    const keys = z
      .object({ RELAY_PAYMENT_WEBHOOK_SECRET: z.string(), RELAY_RECONCILE_SECRET: z.string() })
      .parse(raw);
    const browserDirectory = resolve(directory, "playwright");
    await mkdir(browserDirectory, { recursive: true });
    await writeFile(
      resolve(browserDirectory, "state.json"),
      JSON.stringify({
        url: origin,
        signInUrl: origin,
        inbox,
        today: new Date().toISOString(),
        webhookSecret: keys.RELAY_PAYMENT_WEBHOOK_SECRET,
        preloadedPaging: true,
        reconcileSecret: keys.RELAY_RECONCILE_SECRET,
      }),
    );
    try {
      const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
      const code = await new Promise<number>((accept, reject) => {
        const child = spawn(
          process.execPath,
          [cli, "test", "--config", "playwright.demo.config.ts"],
          {
            cwd: root,
            stdio: "inherit",
            env: commandEnvironment({ RELAY_EVIDENCE_DIR: directory }),
          },
        );
        child.on("error", reject);
        child.on("exit", (code) => {
          accept(code ?? 1);
        });
      });
      assert.equal(code, 0, "The fresh demo browser check failed.");
    } finally {
      await writeFile(
        resolve(browserDirectory, "state.json"),
        JSON.stringify({ url: origin, signInUrl: origin, inbox, today: new Date().toISOString() }),
      );
    }
  }
}
try {
  const deadline = performance.now() + 900000;
  for (;;) {
    try {
      await check();
      break;
    } catch (error) {
      if (!(error instanceof DemoRestarting) || performance.now() >= deadline) throw error;
      record("quickstart.reset", { restarting: true });
      await sleep(1000);
    }
  }
} finally {
  const down = await docker([...composeArgs, "down", "--volumes"]);
  log.write(down.stdout + down.stderr);
  if (process.argv.includes("--cold")) {
    for (const image of priorImages) {
      if (!image.existed && (await docker(["image", "ls", "-q", image.name])).stdout.trim())
        await docker(["image", "rm", image.name]);
    }
  }
  if (compose.exitCode === null) compose.kill("SIGTERM");
  log.end();
}
