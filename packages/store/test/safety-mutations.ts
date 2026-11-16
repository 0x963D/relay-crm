import { APPEND_ONLY_TABLES } from "./append-only-tables.ts";
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
    name: "submitted-plan",
    file: assignment,
    before: "const plan = planDistribution(leads, agents, request.excludePreviousOwner);",
    after:
      "const plan = planDistribution(leads, [...agents].reverse(), request.excludePreviousOwner);",
    test: "every submitted lead keeps its previewed owner and team",
    testFile: "packages/store/test/distribution-contract.int.test.ts",
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
    name: "payment-completion-maker",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before:
      "NOT EXISTS (SELECT 1 FROM payment_makers m WHERE m.payment_id=NEW.id AND m.user_id=a.approver_id)",
    after: "true",
    test: "completion independently excludes the recorder when another person last edited",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "payment-role-insert",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before: " OR u.role_version<>NEW.role_version",
    after: "",
    test: "approval insert independently compares the current role version",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "payment-role-completion",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before: "AND a.role_version=u.role_version",
    after: "",
    test: "completion independently compares both approval role versions",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "payment-application-role",
    file: "packages/store/src/payments.ts",
    before: "approver.roleVersion !== approval.roleVersion ||",
    after: "",
    test: "the second approval rechecks the other approver role version in the application",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "receipt-lease-cycle",
    file: "packages/store/src/outbox.ts",
    before: "AND state IN ('pending','failed') AND cycle_attempts < ${RECEIPT_MAX_ATTEMPTS}",
    after: "AND state IN ('pending','failed')",
    test: "leasing directly enforces the cycle attempt limit",
    testFile: "packages/store/test/outbox.int.test.ts",
  },
  {
    name: "receipt-lease-lifetime",
    file: "packages/store/src/outbox.ts",
    before: "AND attempts < ${lifetimeAttemptLimit}\n      AND next_attempt_at <= ${at}",
    after: "AND next_attempt_at <= ${at}",
    test: "leasing directly enforces the lifetime attempt limit",
    testFile: "packages/store/test/outbox.int.test.ts",
  },
  {
    name: "truncate-intake_events",
    file: "packages/store/prisma/migrations/0002_leads_and_intake/migration.sql",
    before:
      "CREATE TRIGGER intake_events_no_truncate BEFORE TRUNCATE ON public.intake_events FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses intake_events",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-activities",
    file: "packages/store/prisma/migrations/0002_leads_and_intake/migration.sql",
    before:
      "CREATE TRIGGER activities_no_truncate BEFORE TRUNCATE ON public.activities FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses activities",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-audit_log",
    file: "packages/store/prisma/migrations/0002_leads_and_intake/migration.sql",
    before:
      "CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses audit_log",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-distribution_previews",
    file: "packages/store/prisma/migrations/0002_leads_and_intake/migration.sql",
    before:
      "CREATE TRIGGER distribution_previews_no_truncate BEFORE TRUNCATE ON public.distribution_previews FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses distribution_previews",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-idempotency_records",
    file: "packages/store/prisma/migrations/0002_leads_and_intake/migration.sql",
    before:
      "CREATE TRIGGER idempotency_records_no_truncate BEFORE TRUNCATE ON public.idempotency_records FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses idempotency_records",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-ledger_accounts",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before:
      "CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON public.ledger_accounts FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses ledger_accounts",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-ledger_transactions",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before:
      "CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON public.ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses ledger_transactions",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-ledger_lines",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before:
      "CREATE TRIGGER ledger_lines_no_truncate BEFORE TRUNCATE ON public.ledger_lines FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses ledger_lines",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-payment_events",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before:
      "CREATE TRIGGER payment_events_no_truncate BEFORE TRUNCATE ON public.payment_events FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses payment_events",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-webhook_inbox",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before:
      "CREATE TRIGGER webhook_inbox_no_truncate BEFORE TRUNCATE ON public.webhook_inbox FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses webhook_inbox",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-payment_approvals",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before:
      "CREATE TRIGGER payment_approvals_no_truncate BEFORE TRUNCATE ON public.payment_approvals FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses payment_approvals",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-receipt_attempts",
    file: "packages/store/prisma/migrations/0004_outbox_and_receipts/migration.sql",
    before:
      "CREATE TRIGGER receipt_attempts_no_truncate BEFORE TRUNCATE ON public.receipt_attempts FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses receipt_attempts",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "truncate-outbox",
    file: "packages/store/prisma/migrations/0004_outbox_and_receipts/migration.sql",
    before:
      "CREATE TRIGGER outbox_no_truncate BEFORE TRUNCATE ON public.outbox FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();",
    after: "",
    test: "standalone truncate refuses outbox",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
  {
    name: "payment-active-approval-index",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before:
      "CREATE UNIQUE INDEX payment_approvals_active_key ON public.payment_approvals USING btree (payment_id, approver_id) WHERE (voided_at IS NULL);",
    after: "",
    test: "the database refuses duplicate active approvals but permits a fresh approval after voiding",
    testFile: "packages/store/test/payment-guards.int.test.ts",
  },
];
definitions.push(
  {
    name: "work-current-role",
    file: "packages/store/src/work.ts",
    before:
      'const current = await currentActor(tx, actor);\n    const row = await scopedLead(tx, current, input.id, "edit");',
    after:
      'const current = actor;\n    const row = await scopedLead(tx, current, input.id, "edit");',
    test: "working reloads a revoked role inside its transaction, including a replay",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-contact-proof",
    file: "packages/store/src/work.ts",
    before: 'if (work.attempt.outcome === "spokeToThem") contactedAt ??= at;',
    after: "contactedAt ??= at;",
    test: "only spoke to them records contact and no-answer history survives callbacks",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-intake-order",
    file: "packages/store/src/intake.ts",
    before: "await updateLifecycle(tx, decision.leadId, lifecycleFromRow(row));",
    after: "",
    test: "closing races fresh intake and records one of the permitted serial histories",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-repeated-win",
    file: "packages/store/src/work.ts",
    before: 'if (row.status === "won" && work.kind === "close" && work.closing.kind === "won")',
    after:
      'if (false && row.status === "won" && work.kind === "close" && work.closing.kind === "won")',
    test: "two wins collide and create one account and one closing activity",
    testFile: "packages/store/test/work.int.test.ts",
  },
);
definitions.push(
  {
    name: "payments-close-reason",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before: " AND NEW.reason='paid after close'",
    after: "",
    test: "the SQL guard requires paid after close",
    testFile: "packages/store/test/payment-safety.int.test.ts",
  },
  {
    name: "payments-waiting-reason",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before: " AND NEW.reason IN ('amount mismatch','currency mismatch')",
    after: "",
    test: "the SQL guard permits only mismatch reasons",
    testFile: "packages/store/test/payment-safety.int.test.ts",
  },
  {
    name: "payments-send-timeout",
    file: "packages/store/src/outbox.ts",
    before: " ||\n    sendTimeoutMs >= leaseMs",
    after: "",
    test: "the store refuses a send timeout",
    testFile: "packages/store/test/payment-safety.int.test.ts",
  },
  {
    name: "payments-close-scope",
    file: "packages/store/src/payments.ts",
    before: 'type === "closeCheckout" &&',
    after: "false &&",
    test: "closing a checkout independently requires account edit scope",
    testFile: "packages/store/test/payment-safety.int.test.ts",
  },
  {
    name: "payments-card-index",
    file: "packages/store/prisma/migrations/0003_payments_and_ledger/migration.sql",
    before: "'pendingApproval'::text, 'checkoutCreated'::text",
    after: "'pendingApproval'",
    test: "two card checkouts reach the in-progress unique index",
    testFile: "packages/store/test/payment-safety.int.test.ts",
  },
);
definitions.push(
  {
    name: "work-queue-scope",
    file: "packages/store/src/leads.ts",
    before: '        scopeWhere(recordScope(actor, "lead", "read")),',
    after: "",
    test: "the queue filters an admitted agent's leads by the viewer's selected team",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-note-attempt",
    file: "packages/store/src/work.ts",
    before: 'if (summary?.kind !== "attempt") continue;',
    after: "if (summary === null) continue;",
    test: "a note does not count as an attempt in the queue",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-closed-note",
    file: "packages/store/src/work.ts",
    before: 'if (!isOpen(before.state)) throw new AccessError("leadClosed");',
    after: "",
    test: "a note on a closed lead is refused without history",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-lost-activity",
    file: "packages/store/src/work.ts",
    before: "await tx.activity.create({",
    after: 'if (work.kind !== "close") await tx.activity.create({',
    test: "a lost close saves its written reason and one closure activity",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-funnel-identity",
    file: "packages/store/src/work.ts",
    before: "const leads = await funnelLeadRows(tx, current);",
    after:
      'const leads = (await tx.intakeEvent.findMany({ where: { leadId: { not: null } }, include: { lead: { include: { intakeEvents: { where: { outcome: "leadCreated" }, take: 1 } } } } })).flatMap((event) => event.lead ? [event.lead] : []);',
    test: "the funnel counts reopened and reassigned leads once under their creating intake",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-account-team",
    file: "packages/domain/src/access.ts",
    before: "if (actor.team === null && (actor.teams?.length ?? 0) > 1)",
    after: "if (false && actor.team === null && (actor.teams?.length ?? 0) > 1)",
    test: "a team lead must select a team before listing accounts",
    testFile: "packages/store/test/work.int.test.ts",
  },
  {
    name: "work-account-order",
    file: "packages/store/src/accounts.ts",
    before: 'orderBy: [{ lead: { name: "asc" } }, { lead: { email: "asc" } }, { id: "asc" }],',
    after: 'orderBy: [{ createdAt: "desc" }, { id: "desc" }],',
    test: "account lists sort by person name with a scoped total and payment summary",
    testFile: "packages/store/test/work.int.test.ts",
  },
);
definitions.push(
  ...APPEND_ONLY_TABLES.map(([table, , migration]) => ({
    name: `append-only-${table}`,
    file: `packages/store/prisma/migrations/${migration}/migration.sql`,
    before: `CREATE TRIGGER ${table}_append_only BEFORE DELETE OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();`,
    after: "",
    test: `owner append-only ${table}`,
    testFile: "packages/store/test/append-only.int.test.ts",
  })),
);
const filter = process.argv[3];
definitions.push(
  {
    name: "receipt-database-clock",
    file: "packages/store/src/outbox.ts",
    before: "AND next_attempt_at <= ${at} AND (lease_until IS NULL OR lease_until <= now())",
    after: "AND next_attempt_at <= ${at} AND (lease_until IS NULL OR lease_until <= ${at})",
    test: "receipt leases use the database clock",
    testFile: "packages/store/test/outbox.int.test.ts",
  },
  {
    name: "receipt-next-lifetime-attempt",
    file: "packages/store/prisma/migrations/0004_outbox_and_receipts/migration.sql",
    before: "WHERE id=$1 AND attempts=$2",
    after: "WHERE id=$1",
    test: "the app role must insert the next lifetime receipt attempt",
    testFile: "packages/store/test/outbox.int.test.ts",
  },
  {
    name: "payments-missing-final",
    file: "packages/store/src/payments.ts",
    before: '(event.result.status === "missing" && next.status !== "checkoutCreated")',
    after: "false",
    test: "a never-created checkout leaves the scan after one check across five reconciler runs",
    testFile: "apps/web/test/payments.int.test.ts",
  },
);
const mutations = definitions.filter((m) => !filter || m.name.startsWith(filter));
if (!mutations.length) throw new Error("No matching mutations.");
const files = [
  ...new Set(
    mutations.map((m) => m.testFile ?? "packages/store/test/access-assignment.int.test.ts"),
  ),
];
const command = `pnpm exec dotenv -- vitest run --project integration ${files.join(" ")}`;

async function run(name: string, selected?: { test: string; testFile?: string }) {
  const args = [
    resolve("node_modules/dotenv-cli/cli.js"),
    "--",
    process.execPath,
    resolve("node_modules/vitest/vitest.mjs"),
    "run",
    "--project",
    "integration",
    ...(selected
      ? [
          selected.testFile ?? "packages/store/test/access-assignment.int.test.ts",
          "-t",
          selected.test,
        ]
      : files),
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout}${result.stderr}`;
  await writeFile(resolve(outputDirectory, `${name}.log`), output);
  if (result.error) throw result.error;
  return { status: result.status, output };
}

for (const mutation of mutations) {
  const source = await readFile(mutation.file, "utf8");
  if (source.split(mutation.before).length !== 2)
    throw new Error(`Expected one replacement for ${mutation.name}`);
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
    const result = await run(mutation.name, mutation);
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
