import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const argument = process.argv[2];
if (!argument) throw new Error("Pass a directory for mutation evidence.");
const outputDirectory = resolve(argument);
await mkdir(outputDirectory, { recursive: true });

const assignment = "packages/store/src/distribution.ts";
const definitions: {
  name: string;
  file: string;
  before: string;
  after: string;
  test: string;
  testFile?: string;
}[] = [
  {
    name: "replay",
    file: "packages/store/src/idempotency.ts",
    before: "if (prior) {",
    after: "if (false && prior) {",
    test: "a replay returns only the first result after scope and role change",
  },
  {
    name: "preview-owner",
    file: assignment,
    before: "preview?.actorId !== current.userId || preview.fingerprint !== input.fingerprint",
    after: "!preview || preview.fingerprint !== input.fingerprint",
    test: "another manager cannot submit someone else's preview",
  },
  {
    name: "agent-role",
    file: "packages/domain/src/access.ts",
    before: 'candidate?.role === "agent" && candidate.teamKind === "sales"',
    after: 'candidate?.teamKind === "sales"',
    test: "assignment refuses a sales member whose current role is not agent",
  },
  {
    name: "sales-team",
    file: "packages/domain/src/access.ts",
    before: 'candidate?.role === "agent" && candidate.teamKind === "sales"',
    after: 'candidate?.role === "agent"',
    test: "assignment refuses an agent in an accounts team",
  },
  {
    name: "pool-preview",
    file: assignment,
    before: 'if (row.status !== "new") throw new AccessError("conflict");',
    after: "",
    test: "a distribution preview refuses an assigned lead",
  },
  {
    name: "edit-current-actor",
    file: assignment,
    before:
      'const current = await currentActor(tx, actor);\n    await scopedLead(tx, current, id, "edit");',
    after: 'const current = actor;\n    await scopedLead(tx, current, id, "edit");',
    test: "editLead reloads the actor after management access is revoked",
  },
  {
    name: "account-current-actor",
    file: "packages/store/src/accounts.ts",
    before:
      "const current = await currentActor(tx, actor);\n    const row = await tx.account.findUnique",
    after: "const current = actor;\n    const row = await tx.account.findUnique",
    test: "getAccount reloads the actor after management access is revoked",
  },
  {
    name: "unchanged-reassignment",
    file: assignment,
    before: "if (JSON.stringify(before) === JSON.stringify(next.value)) return false;",
    after: "",
    test: "reassigning the current owner reports no change and writes no history",
  },
  {
    name: "payment-completion-recorder",
    file: "packages/store/prisma/migrations/0024_payment_makers/migration.sql",
    before: " AND a.approver_id<>NEW.recorded_by_id",
    after: "",
    test: "completion independently excludes the recorder when another person last edited",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "payment-role-insert",
    file: "packages/store/prisma/migrations/0024_payment_makers/migration.sql",
    before: " OR u.role_version<>NEW.role_version",
    after: "",
    test: "approval insert independently compares the current role version",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "payment-role-completion",
    file: "packages/store/prisma/migrations/0024_payment_makers/migration.sql",
    before: "AND a.role_version=u.role_version ",
    after: "",
    test: "completion independently compares both approval role versions",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
];
const filter = process.argv[3];
const mutations = definitions.filter((m) => !filter || m.name.startsWith(filter));
if (!mutations.length) throw new Error("No matching mutations.");
const files = [
  ...new Set(
    mutations.map((m) => m.testFile ?? "packages/store/test/access-assignment.int.test.ts"),
  ),
];
const command = `pnpm exec dotenv -- vitest run --project integration ${files.join(" ")}`;

async function run(name: string) {
  const result = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const output = `${result.stdout}${result.stderr}`;
  await writeFile(resolve(outputDirectory, `${name}.log`), output);
  if (result.error) throw result.error;
  return { status: result.status, output };
}

const baseline = await run("baseline");
if (baseline.status !== 0) throw new Error("The baseline failed. No mutation ran.");
const results = [];
for (const mutation of mutations) {
  const original = await readFile(mutation.file, "utf8");
  if (original.split(mutation.before).length !== 2)
    throw new Error(`Expected one replacement for ${mutation.name}`);
  try {
    await writeFile(mutation.file, original.replace(mutation.before, mutation.after));
    const result = await run(mutation.name);
    const failures = result.output.split("\n").filter((line) => line.includes("FAIL"));
    const caught = result.status !== 0 && failures.some((line) => line.includes(mutation.test));
    results.push({
      name: mutation.name,
      caught,
      test: mutation.test,
      status: result.status,
      failures,
    });
    process.stdout.write(
      `${mutation.name}: ${caught ? "caught" : "NOT CAUGHT"} by ${mutation.test}\n`,
    );
  } finally {
    await writeFile(mutation.file, original);
  }
}
const restored = await run("restored");
await writeFile(
  resolve(outputDirectory, "results.json"),
  JSON.stringify({ command, results, restoredStatus: restored.status }, null, 2),
);
if (restored.status !== 0 || results.some((result) => !result.caught))
  throw new Error("Mutation verification failed.");
