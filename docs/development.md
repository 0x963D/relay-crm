# Development

[Back to Relay CRM](../README.md)

This page covers how the code is divided, how to run it without Docker, what each command does and how the tests are built. The rules that matter are enforced by the build and not by convention. A second way to start a transaction, a database client in the web app, or a clock read in a product rule fails lint, typecheck or a test.

## Three packages

`pnpm -r list --depth -1` lists them. Each has one job and one thing it must not do.

| Package           | Owns                                             | Must not do                         | What stops it                                                |
| ----------------- | ------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------ |
| `packages/domain` | Product rules as pure functions                  | Import a dependency, read the clock | An empty dependency list, no ambient types, and lint         |
| `packages/store`  | Every SQL statement and every transaction        | Export the database client          | Its entry point exports operations only                      |
| `apps/web`        | HTTP routes, sign-in, intake sources and screens | Import a database client            | Its manifest declares none, and a test fails if one is added |

The domain takes the time and any randomness as arguments. It loads no ambient types, so `process`, `fetch` and `node:` imports do not typecheck there, and lint refuses `Date.now()`, `new Date()` without an argument and `Math.random()`. Its rules can then be tested as plain functions, and the same input always gives the same decision.

Two lint rules shape the store. Only `tx.ts` may call Prisma's `$transaction`, so every transaction goes through `transact`. Only `leads.ts` may query the leads table directly, so every lead read sits beside the scope rule that filters it.

The web app parses its settings in one file, `apps/web/src/server/env.ts`, and lint refuses `process.env` in the rest of the app. The exceptions are listed in `eslint.config.ts`: `env-file.ts`, which loads the demo's configuration file, the Prisma config and two test files. A production server refuses to start on a setting it cannot parse.

## Every transaction is serializable and retried

`transact` in `packages/store/src/tx.ts` is the only place a transaction starts. It runs the body at PostgreSQL's SERIALIZABLE isolation level. Every body follows one contract: read the current state, decide, then write the difference.

Two transactions that decide on the same stale state cannot both commit. PostgreSQL fails one with a serialization failure, a deadlock, or a unique violation on an index the two were racing for. `transact` then waits a random interval of up to 200 milliseconds and runs the whole body again. The second run reads what the first one wrote and decides differently. After ten attempts the original error reaches the caller.

The obvious alternative is READ COMMITTED with an explicit lock per row. That works only if every writer, including ones added later, remembers to take the same locks in the same order. It also has nothing to lock when the row does not exist yet, which is the intake case of two submissions for one new email. With SERIALIZABLE, one rule covers every writer, and a forgotten lock cannot become a double credit.

The cost is throughput under contention. A transaction that loses does its work again, and PostgreSQL tracks what serializable transactions read at the level of index pages. On small tables, writes for unrelated people can therefore conflict, and a burst of writes to one table resolves close to one at a time. That is acceptable at a sales team's write rate. It is the first thing to revisit if one table takes many writes a second.

Not every unique violation is a race. `RACE_CONSTRAINTS` in `tx.ts` classifies each unique index as `retry` or `reject`. A second lead for one email is a race that a fresh read resolves. A duplicate lead ID is a bug that a retry would only repeat. A test reads the PostgreSQL catalog and fails when an index has no classification, so a new unique index forces the decision.

```sh
pnpm exec dotenv -- vitest run --project integration packages/store/test/tx.int.test.ts
```

That file pins each error shape against a real database, then the retry and the limit of ten attempts.

## Audit rows

Assignment, lead work, lead detail edits, reopening and every payment state change write a row to `audit_log` in the same transaction. A failed audit write rolls the change back. An unchanged lead edit writes nothing. A row names its actor, an action from a closed list, a typed subject, a JSON snapshot before and after, and the HTTP request ID. A check constraint requires the actor to be a person or a named system actor and never both.

Operations with an idempotency key go through `idempotent` in `packages/store/src/idempotency.ts`, which runs inside the caller's transaction. [The API page](api.md#idempotency-keys) describes what a client sees.

## Run it without Docker

You need Node.js 24.2 or later, pnpm 11.18.0 and a PostgreSQL 17 server used for nothing else.

1. Install the dependencies and generate the Prisma client.

   ```sh
   pnpm install
   pnpm db:generate
   ```

2. Start PostgreSQL. This command runs it in a container on port 54329.

   ```sh
   docker run --name relay-crm-pg -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay \
     -e POSTGRES_DB=relay -p 127.0.0.1:54329:5432 -d postgres:17
   ```

3. Create the [two database roles](access-security.md#the-two-database-roles). Replace both example passwords.

   ```sh
   docker exec -i relay-crm-pg psql -U relay -d relay -v owner_password=fake-local-owner-password -v app_password=fake-local-app-password < packages/store/scripts/setup-roles.sql
   ```

4. Copy `.env.example` to `.env`. Set `DATABASE_URL` to the `relay_app` connection and `MIGRATION_DATABASE_URL` to the `relay_owner` connection. Clear `AUTH_SECRET`, because the server refuses to start with the placeholder.

5. Apply the migrations and start the app.

   ```sh
   pnpm db:migrate
   pnpm dev
   ```

   The app is at <http://localhost:3000>. With sign-in off it has no way to tell who you are, so every page shows the sign-in screen.

6. To work without sign-in, set `RELAY_DEV_ACTOR=1` in `.env` and restart. The app then acts as a built-in development user. `RELAY_DEV_ROLE` sets its role and defaults to `agent`. Set it to `owner` to see the pool.

7. Send a lead through the web form.

   ```sh
   curl -X POST http://localhost:3000/api/intake/form \
     -H 'content-type: application/json' \
     -d '{"email":"ana@example.com","name":"Ana Silva","campaign":"spring"}'
   ```

   The response is `{"received":true}` with status 202, and Ana Silva appears in the pool.

The development user exists only in a development server. A production build refuses to start when `RELAY_DEV_ACTOR` is set, even with `NODE_ENV=development`.

## Commands

| Command                                    | What it does                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `pnpm dev`                                 | Starts the app in development mode on `127.0.0.1`                                    |
| `pnpm build`                               | Builds the app. It reads no settings and needs no database                           |
| `pnpm start`                               | Serves the built app                                                                 |
| `pnpm db:generate`                         | Generates the Prisma client from the schema                                          |
| `pnpm db:migrate`                          | Applies migrations through `MIGRATION_DATABASE_URL`                                  |
| `pnpm db:seed`                             | Seeds the demo company into an empty database. It needs both database URLs and SMTP  |
| `pnpm demo:reset`                          | Wipes and reseeds a database that carries the demo's marker. It needs `RELAY_DEMO=1` |
| `pnpm demo:check <directory>`              | Runs the [Compose demo end to end](demo.md#first-run-measurements)                   |
| `pnpm import:csv <file>`                   | Imports a CSV file through intake and prints a report                                |
| `pnpm reconcile`                           | Checks due card payments at the provider                                             |
| `pnpm outbox`                              | Sends due payment receipts through SMTP                                              |
| `pnpm lint`                                | Runs the style guard, the documentation check and ESLint                             |
| `pnpm format:check`                        | Checks formatting with Prettier                                                      |
| `pnpm typecheck`                           | Typechecks every package and its tests                                               |
| `pnpm test`                                | Runs the unit tests. They need no database                                           |
| `pnpm test:int`                            | Runs the integration tests against the PostgreSQL server in `.env`                   |
| `pnpm test:proofs`                         | Runs each command in the README's proof list and checks which file it ran            |
| `pnpm test:prod`                           | Builds the app and tests the production server over HTTP                             |
| `pnpm test:browser`                        | Runs the browser tests against the built app                                         |
| `pnpm test:mutations <directory> <prefix>` | Removes safety checks one at a time and requires a named test to fail                |
| `pnpm test:image`                          | Checks the app image and runs the maintenance entry point with networking disabled   |
| `pnpm capture`                             | Writes screenshots of the built app under `test-results/evidence/built/`             |
| `pnpm capture:readme`                      | Rewrites the six README images under `docs/images/`                                  |

## Tests

The unit tests cover the domain and the parts of the web app that need no database, such as body limits, CSV parsing and the SMTP adapter against a local server.

The integration tests run against real PostgreSQL, because the guarantees on these pages live in constraints, triggers and isolation levels that a fake would not have. Before the run, a setup step creates a template database and migrates it. Each test then gets its own database cloned from the template and drops it afterwards. A rollback per test is not possible, because the code under test owns its transactions. Test files run one at a time. The code under test connects as `relay_app`. Only the fixtures use the owner connection, for setup the app role is not allowed to do and for checks of what the owner itself is refused.

A race test does not rely on timing. A helper session takes a lock that lets every racer read and decide, then holds each at its first write. When all of them are waiting, it releases the lock and they collide on the same stale state.

`pnpm test:prod` builds the app and starts the real server. It signs people in through a local SMTP receiver and drives intake, lead work and payments through the HTTP API. It also checks what a production server refuses, such as the development user and a weak secret.

`pnpm test:browser` needs `pnpm exec playwright install chromium` and `pnpm build` first. It serves the built app over a fresh seeded database and walks the main journeys in Chromium. Each tested screen also runs axe against the WCAG 2 and 2.1 A and AA rules and axe's best-practice rules, and a violation fails the test.

`pnpm test:mutations` asks whether the tests would notice a missing guard. It removes one check from the source or a migration, runs the test that is meant to catch it, requires that test to fail, restores the file and reruns the unchanged tests. The optional prefix selects a group, such as `payment-`, `receipt-lease`, `truncate-` or `work-`.

Run the commands that use the database one at a time. They rebuild the same template database.

## Screens

| Route                                                   | Shows                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/sign-in`                                              | Sign-in by emailed code, and the demo's three buttons                         |
| `/queue`, `/queue/leads/[leadId]`                       | The signed-in agent's queue, with a lead open beside it                       |
| `/agents/[agentId]`, `/agents/[agentId]/leads/[leadId]` | One agent's queue, for managers and team leads                                |
| `/pool`                                                 | Unassigned leads and assignment                                               |
| `/accounts`, `/accounts/[id]`, `/accounts/[id]/ledger`  | Accounts, one account and its ledger                                          |
| `/payments`, `/payments/[id]`, `/payments/[id]/edit`    | Payment groups, one payment, and the form that edits a waiting manual payment |
| `/payments/new/[accountId]/[method]`                    | The card and manual payment forms                                             |
| `/funnel`                                               | Campaign totals, with a CSV export                                            |

`/` redirects to the home screen for the role: the queue for an agent, payments for an accountant and the pool for everyone else.

Screens call the same tRPC router as outside clients. A server component calls it in process, and the browser calls `/api/trpc`. Access is decided in the store. A page's role check only chooses which screen to show, and the operation behind it still refuses a caller outside its scope.

The appearance follows the system setting until the person picks Light or Dark. The app serves the Archivo variable font from its own files under the [SIL Open Font License 1.1](../apps/web/src/app/fonts/OFL.txt) and requests no font from another host.

## The style guard

`pnpm lint` runs `scripts/check-styles.mjs` before ESLint. The guard keeps every colour, size and weight in the token definitions in `apps/web/src/app/globals.css`, so a screen cannot drift from the theme one literal at a time. It rejects:

- arbitrary Tailwind values and arbitrary properties, such as a width in pixels written into a class name
- Tailwind's default palette colours and shadows, which the theme also removes
- font weights other than normal, medium, semibold and bold
- selectors that style a child through its parent's class
- inline styles, and literal CSS colours and sizes outside the token definitions

An exception needs an entry in `scripts/style-allowlist.json` with a written reason. The one entry covers the sandbox provider's page, which is styled as another company's page on purpose. An entry for a file that no longer exists fails the check.

`pnpm --filter @relay/web types:api` generates the mobile app's API types. Root and mobile lint and typecheck, and web typecheck, run it automatically.

`pnpm lint` also runs `scripts/check-docs.mjs`. It checks relative links, heading fragments, the README's 8,000-byte limit, and the mobile guide's server environment variable.
