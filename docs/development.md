# Development

[Back to Relay CRM](../README.md)

## How it is built

`pnpm -r list --depth -1` lists the workspace packages. Each one holds one kind of knowledge.

| Package           | What it knows                                         | What it must not do                 |
| ----------------- | ----------------------------------------------------- | ----------------------------------- |
| `packages/domain` | Lead states, access scopes, email identity and intake | Import a dependency, read the clock |
| `packages/store`  | Every SQL statement and every transaction             | Export the Prisma client            |
| `apps/web`        | HTTP, intake, authentication, payments and screens    | Depend on a database client         |

The build enforces the right-hand column. The domain declares no dependencies and loads no ambient
types, so `process`, `fetch` and `node:*` do not typecheck there. Lint forbids `Date.now()` and
`Math.random()` in it. The web app has no database client to import, so it can only reach data
through the operations the store exports.

## Run it

Use the Node.js and pnpm versions declared in `package.json`, and a dedicated PostgreSQL server.

1. Install the dependencies and generate the Prisma client.

   ```sh
   pnpm install
   pnpm db:generate
   ```

2. Copy `.env.example` to `.env` and set `DATABASE_URL` and `MIGRATION_DATABASE_URL`. Clear the placeholder `AUTH_SECRET`
   to keep sign-in off, or replace it with a generated secret before enabling sign-in. Use a dedicated database.

   ```sh
   docker run --name relay-crm-pg -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay \
     -e POSTGRES_DB=relay -p 127.0.0.1:54329:5432 -d postgres:17
   ```

3. Create the migration owner and restricted app roles in that dedicated server. Replace both
   example passwords and put the matching URLs in `.env`.

   ```sh
   docker exec -i relay-crm-pg psql -U relay -d relay -v owner_password=fake-local-owner-password -v app_password=fake-local-app-password < packages/store/scripts/setup-roles.sql
   ```

   `relay_owner` owns the schema and tables. It has `CREATEDB` for isolated test databases and
   no superuser or role-management attribute. `MIGRATION_DATABASE_URL` is its connection.
   `relay_app` has no ownership, superuser, `CREATEDB`, `CREATEROLE` or `BYPASSRLS` attribute,
   and no membership of the owner role. `DATABASE_URL` is its connection. Do not put the owner
   credentials in the serving app's environment.

   The app has schema usage and sequence usage. The [access reference](access-security.md#application-grants) lists its table grants and additional column updates. Memberships, teams and email suppressions are read-only.
   Authentication tables and request limits allow deletion. No app table grants `TRUNCATE`,
   DDL or trigger control. `pnpm test -- packages/store/test/readme.test.ts` checks these tables
   against `packages/store/test/app-privileges.ts`.

   The statement-level `BEFORE TRUNCATE` triggers remain a second defence, including for the owner.
   Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/database-role.int.test.ts packages/store/test/schema.int.test.ts`
   to check permissions and the truncate guards.

4. Apply migrations and start the app.

   ```sh
   pnpm db:migrate
   pnpm dev
   ```

   The lead list is at <http://localhost:3000>. Without a session it shows the not-signed-in page.
   To use the existing development grant, set `RELAY_DEV_ACTOR=1`. Its role defaults to agent.
   Set `RELAY_DEV_ROLE=owner` to see the pool. The grant works only in development-server bundles.
   The build fixes that fact using Next's configuration phase and an inlined flag.
   Production startup refuses a nonempty `RELAY_DEV_ACTOR`, even with `NODE_ENV=development`.
   `pnpm test:prod` reproduces that startup and checks that no development user is created.

5. Send a lead through the web form endpoint.

   ```sh
   curl -X POST http://localhost:3000/api/intake/form \
     -H 'content-type: application/json' \
     -d '{"email":"ana@example.com","name":"Ana Silva","campaign":"spring"}'
   ```

   The response is `{"received":true}` with status 202. With `RELAY_DEV_ROLE=owner` the lead
   appears in the list.

## Commands

| Command                                  | What it does                                                    |
| ---------------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                               | Starts the app in development mode                              |
| `pnpm build`                             | Builds the app. It needs no database                            |
| `pnpm start`                             | Serves the built app                                            |
| `pnpm db:generate`                       | Generates the Prisma client from the schema                     |
| `pnpm db:migrate`                        | Applies migrations through `MIGRATION_DATABASE_URL`             |
| `pnpm reconcile`                         | Checks due card payments at the provider                        |
| `pnpm test:mutations <output-directory>` | Removes safety checks and requires their tests to fail          |
| `pnpm outbox`                            | Delivers due payment receipts through SMTP                      |
| `pnpm import:csv <file>`                 | Imports a CSV file through intake and prints a report           |
| `pnpm test`                              | Runs the unit tests. They need no database                      |
| `pnpm test:int`                          | Runs the integration tests against the server in `DATABASE_URL` |
| `pnpm test:prod`                         | Builds and tests the production server against PostgreSQL       |
| `pnpm lint`                              | Checks styles, documentation links and type-aware ESLint rules  |
| `pnpm format:check`                      | Checks formatting with Prettier                                 |
| `pnpm typecheck`                         | Typechecks every package and its tests                          |

The integration tests create a template database and one database per test, and drop each test's
database when the test ends. Only `MIGRATION_DATABASE_URL` needs `CREATEDB`.
The app and test operations use the restricted `DATABASE_URL` role. Test fixtures use an explicit
owner connection to create schemas, set up fixture rows, install failure triggers, restore marked
demos and verify owner-level defences.
Database test files run sequentially.

## Shared store support

`idempotent` in `packages/store/src/idempotency.ts` stores request hashes and JSON results in
`idempotency_records`. Its unique key is `(scope, key)`. User scopes are `user:<user ID>`.
System scopes are `system:<job name>`. The helper canonicalizes JSON object keys, preserves array
order, and compares both the request hash and operation name before replaying. It runs inside the
caller's transaction and does not authorize the operation. Callers authorize new work before writing.
Distribution uses this helper. Its former receipt table and lookup no longer exist.

`Principal` includes the named system actors `intake`, `providerWebhook` and `reconciler`.
`recordScope` grants intake only lead identity lookup and reopening. It denies full-record reads,
contact-field edits and assignment to every system actor. The providerWebhook and reconciler system actors may settle payments. Only the reconciler may scan due payments.
Neither has human record-read or edit access.
The database requires an audit actor to be either a user or a named system actor, never both or neither.

Audit actions include lead assignment and reopening, checkout creation, payment state changes, review closure
and ledger posting. Subjects are typed as leads, accounts, payments or ledger transactions.
The database enforces these closed sets and object snapshots, and refuses audit updates and deletes.
The HTTP boundary generates a request ID and returns it in `X-Request-ID`. Assignment activity,
payment events and audit rows keep that ID. Idempotent operations also keep their separate
`idempotency_id`. Reopening uses its intake event ID. The receipt foreign key checks at commit so the audit
can precede its immutable receipt inside the same transaction.

`RACE_CONSTRAINTS` in `packages/store/src/tx.ts` classifies every public unique index as `retry` or
`reject`. The PostgreSQL catalog test fails if an index has no classification or a named index is absent.
A new index therefore needs an explicit retry decision.

`pnpm test` runs unit tests. `pnpm test:int` runs integration tests against real PostgreSQL,
including forced races, catalog checks for unique indexes and grants, and an enabled-trigger
catalog check for every append-only row guard. Owner-connection tests attempt both updates and
deletes on every append-only table.
`pnpm test:prod` checks the production build, SMTP sign-in and scoped API errors.
`pnpm test:mutations <output-directory>` removes each covered safety check in turn, requires its
named test to fail, restores the source in `finally`, and reruns the unchanged tests.

## Screens and browser checks

The screens use a carbon-blue shell, state colours and ruled custody lines. Appearance follows your system until you choose Light or Dark.
Archivo is a variable font with weight and width axes. Next.js serves the font from this app.
Its [SIL Open Font License 1.1](../apps/web/src/app/fonts/OFL.txt) permits embedding and redistribution.
The font comes from [Google Fonts' Archivo files](https://github.com/google/fonts/tree/main/ofl/archivo).
The app sends no font request to another host.

After the development database is available, run these commands from the repository.

```sh
pnpm exec playwright install chromium
pnpm build
pnpm test:browser
pnpm capture
```

`test:browser` runs the production build against a fresh, seeded database on the configured PostgreSQL
server. It submits a public enquiry, assigns it from the pool, records attempts, sets, moves and
clears a callback, adds a note and wins an account. It also checks emailed-code sign-in, code
refusal, keyboard focus, reduced motion and the light, dark and phone queues.
Axe checks WCAG 2 A and AA, WCAG 2.1 A and AA, and its best-practice rules on each tested screen.
The browser CI job runs these checks and the capture script. A failing check fails the job.

`capture` writes 2x images under `test-results/evidence/built/`. Set `RELAY_EVIDENCE_DIR` to use another directory. Logs, accessibility results and failure traces stay beside them.
`pnpm capture:readme` writes the six queue, pool and payment images under `docs/images/` at twice the pixel density. The capture seed and browser share a fixed date. Counts, names, dates and assignment results
come from the seeded API, so they can differ from the illustrative board.
Both commands stop their servers and drop only their own test database when they finish.

### Routes and data

`/sign-in` handles emailed codes and demo sign-in. `/queue` shows the signed-in agent's work;
`/queue/leads/[leadId]` opens a lead beside it. Managers and team leads use
`/agents/[agentId]` and `/agents/[agentId]/leads/[leadId]`. `/pool` handles assignment.
`/payments` shows payment groups and records. `/payments/new/[accountId]/[method]` hosts both money forms. `/accounts` opens account details and ledgers. `/funnel` shows campaign totals and exports them as CSV. `/accountant` redirects to Payments. `/` redirects to the role's home.
Links use normal browser navigation, including modified clicks. Queue layouts stay mounted when
the lead changes. Each route segment has loading and error boundaries.

The server resolves the session once per render, starts independent reads through tRPC's query
options, and streams results through Suspense into the hydrated cache. The browser keeps one QueryClient.
Components use the same router-generated options and mutation hooks. A completed save invalidates
the affected record, queue, pool and agent counts. A business refusal also refreshes those reads.
A transport failure preserves the draft and its request key for a retry.

Controls in `apps/web/src/components/ui` use the standard token names from `components.json`.
They contain no screen selectors. Status slips use `waiting`, `refused`, `complete`, `fresh`,
`neutral` and `outline` variants. Pane layouts respond to container width.
`globals.css` defines the tokens and base layer; controls and screens compose Tailwind utilities.

`pnpm lint` includes the style guard in `scripts/check-styles.mjs`. It rejects arbitrary properties and pixel utilities, default palette colours and shadows, parent-class overrides, unsupported font weights and inline style bypasses. The theme clears the default palette and shadow scale. The allow-list in `scripts/style-allowlist.json` keeps the future dialog width and the sandbox's separate font weight, each with its reason. Any future exception needs a file, exact value and reason.
Run database-backed verification commands sequentially. They rebuild the same test template.

`pnpm lint` also runs `scripts/check-docs.mjs`. It resolves relative links and Markdown heading fragments in the README and every Markdown page under `docs/`. It refuses a README above 8,000 bytes.
