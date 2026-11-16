import assert from "node:assert/strict";
import { z } from "zod";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { commandEnvironment } from "../src/server/env.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const directory = resolve(process.argv[2] ?? "");
assert(
  process.argv[2] && !directory.startsWith(root),
  "Pass an evidence directory outside the repository.",
);
await mkdir(directory, { recursive: true });
const card = "card checkout recovers";
const manual = "manual payment needs";
const mutations = [
  {
    name: "missing-pay-link",
    file: "components/payment-form.tsx",
    find: "url: response.checkout.url",
    replace: "url: null",
    test: card,
  },
  {
    name: "hidden-completion",
    file: "components/payment-detail.tsx",
    find: '"Credited once"',
    replace: '"Completion hidden"',
    test: card,
  },
  {
    name: "second-posting-shown",
    file: "components/payment-detail.tsx",
    find: "{payment.postingCount}",
    replace: "{payment.postingCount + 1}",
    test: card,
  },
  {
    name: "recorder-can-approve",
    file: "components/payment-detail.tsx",
    find: "payment.actions.approve &&",
    replace:
      '(payment.actions.approve || payment.actions.approvalRefusal === "paymentRecorder") &&',
    test: manual,
  },
  {
    name: "missing-ledger-credit",
    file: "components/accounts.tsx",
    find: "minor: entry.amount",
    replace: "minor: 0n",
    test: manual,
  },
  {
    name: "unexplained-conflict",
    file: "lib/failures.ts",
    find: "This account already has a payment in progress.",
    replace: "The request was refused.",
    test: manual,
  },
  {
    name: "pay-link-survives-reload",
    file: "components/payment-form.tsx",
    find: "  const [copied, setCopied]",
    replace:
      '  useEffect(() => { const saved = sessionStorage.getItem("mutation-checkout"); if (saved) setCreated(JSON.parse(saved)); }, []);\n  useEffect(() => { if (created) sessionStorage.setItem("mutation-checkout", JSON.stringify(created)); }, [created]);\n  const [copied, setCopied]',
    test: card,
  },
];
async function run(
  args: string[],
  cwd: string,
  log: string,
  env: ReturnType<typeof commandEnvironment>,
) {
  return new Promise<number>((accept, reject) => {
    let output = "";
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      void writeFile(log, output).then(() => {
        accept(code ?? 1);
      }, reject);
    });
  });
}
const build = (log: string) =>
  run(
    [require.resolve("next/dist/bin/next"), "build"],
    join(root, "apps/web"),
    log,
    commandEnvironment({}),
  );
const results = [];
try {
  for (const mutation of mutations.filter(
    (mutation) => !process.argv[3] || mutation.name === process.argv[3],
  )) {
    const file = join(root, "apps/web/src", mutation.file);
    const original = await readFile(file, "utf8");
    assert(original.includes(mutation.find), `Mutation anchor missing: ${mutation.name}`);
    const evidence = join(directory, mutation.name);
    await mkdir(evidence, { recursive: true });
    try {
      await writeFile(file, original.replace(mutation.find, mutation.replace));
      assert.equal(
        await build(join(evidence, "build.log")),
        0,
        `${mutation.name} must compile before its test runs`,
      );
      const code = await run(
        [
          require.resolve("@playwright/test/cli"),
          "test",
          "apps/web/test/browser/payments.spec.ts",
          "--grep",
          mutation.test,
        ],
        root,
        join(evidence, "test.log"),
        commandEnvironment({ RELAY_EVIDENCE_DIR: evidence }),
      );
      const result = z
        .object({ stats: z.object({ unexpected: z.number() }) })
        .parse(JSON.parse(await readFile(join(evidence, "playwright/results.json"), "utf8")));
      assert(
        code !== 0 && result.stats.unexpected === 1,
        `${mutation.name} survived or failed outside its test`,
      );
      results.push({ name: mutation.name, detected: true });
      process.stdout.write(`${mutation.name}: detected\n`);
    } finally {
      await writeFile(file, original);
    }
  }
} finally {
  await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
  assert.equal(await build(join(directory, "restored-build.log")), 0, "Restored source must build");
}
