# Relay CRM

Relay CRM is a sales CRM for a small team that buys leads from ads and closes them by phone.
It is a local build. Nothing has been published. The name is a working title.

## Run the demo

The seeded queue shows all five groups from 00:00 until 18:30 in the configured local time zone, with two due-today callbacks before 17:30.

Install Docker and Docker Compose, then run this command in the repository.

```sh
docker compose up
```

Wait until `docker compose ps` shows `app` as healthy. `GET /api/health` returns an empty 200
response when migrations and the seed are ready. During setup or a reset it returns 503.
Open the app at <http://127.0.0.1:3107> and the inbox at <http://127.0.0.1:8127>.
These are the only published ports. Both bind to loopback, and the database has no published port.
`docker compose config` prints the effective ports and service configuration.

The upstream images in `compose.yaml` and `Dockerfile` pin a tag and its manifest digest.
To update one, choose its new tag, run `docker buildx imagetools inspect <image>:<tag>`, and replace
both the tag and the `sha256` digest with that manifest's values.
Run `pnpm demo:check <evidence-directory>` before committing the update.

To run another copy, choose a different project name and free ports. In a POSIX shell, for example,
run `COMPOSE_PROJECT_NAME=relay-second RELAY_HTTP_PORT=3117 RELAY_INBOX_PORT=8137 docker compose up`.
Use the same variables with later Compose commands. `RELAY_TIME_ZONE` selects the local day for
callbacks and reset, and defaults to UTC.

The invented company is Tidewell Language School. The sign-in page offers Priya Raman, manager,
Dele Akinwale, agent, and Esther Okafor, accountant. The manager opens the lead pool, and the agent
opens a queue with five groups. Staff can also sign in with an emailed code.
The lead screens support assignment by hand, round-robin previews, attempts, callbacks, notes and
closing a lead. A rejected preview assigns nothing. Only "Spoke to them" marks a lead contacted.
Payments, the ledger, the funnel and the accounts list have typed APIs. Their screens are separate work.

The data is invented and resets at the start of the next local day.
The demo's logins are shared, so one visitor can give a manual payment both approvals.
The demo's inbox keeps every message, and anyone who can open it can sign in by emailed code as any of the invented staff.
The demo checks card payments more often than a production setup would, and payment API reads return its configured first-check delay and interval.
The public form stores a submitted email as a lead and can reopen a lost lead.
A visitor can leave data changed until the next reset.

Compose creates private configuration files in separate volumes. The resetter holds the owner
connection, applies migrations, recovers an interrupted seed and restores the demo each local day.
The app connects as `relay_app`; the app and scheduler never receive the owner's credentials.
The scheduler calls reconciliation and the outbox through their authenticated HTTP routes.
The inbox retains mail across database resets. `docker compose down --volumes` removes the
project's containers and volumes, including that inbox.

To restore a running demo, run
`docker compose exec -T resetter node --import tsx apps/web/scripts/demo-reset.ts --container`.
It ends every session. For a separately configured local database, `pnpm db:seed` requires the
owner and app URLs and an SMTP sink. Repeating it on a ready seed changes nothing.
`pnpm demo:reset` uses the owner connection and requires `RELAY_DEMO=1` and the owner-only marker.
A marker left at `building` makes startup restore the seed before serving requests.

### First-run measurements

One fresh-clone run took **130395 ms**, measured by `pnpm demo:check ../relay-demo-evidence --cold`.
Its timer starts at `docker compose up` and ends after readiness, role sign-ins and the initial
queue, payment and ledger reads. Service base images were already present. The application build
cache was empty in a dedicated builder. The same check then proved scheduled webhook recovery,
SMTP receipt delivery and an owner-side reset. This is one run on one machine, not a timing guarantee.
The check requires the development dependencies from `pnpm install --frozen-lockfile`.

That run reported these uncompressed image sizes.

| Image                            |      Bytes |
| -------------------------------- | ---------: |
| App                              |  404629766 |
| Maintenance                      | 2286066981 |
| All five required images, summed | 3704790198 |

The maintenance image retains the migration and seed tools. The app contains standalone output
and runs as `node`. The sum counts shared image layers more than once. The dedicated build cache
reported another **2.358 GB**; database and inbox volumes are additional. These figures describe
Docker's reported image and cache sizes, rather than an exact increase in host disk use.

To repeat the timing with an empty application build cache, choose fresh builder and project names.

```sh
docker buildx create --name relay-measure-builder --driver docker-container
BUILDX_BUILDER=relay-measure-builder COMPOSE_PROJECT_NAME=relay-measure pnpm demo:check ../relay-demo-evidence --cold
```

In another terminal, while that check's project is up, these commands report the app and maintenance
sizes, the sum of all distinct project images, and the dedicated cache size.

```sh
export COMPOSE_PROJECT_NAME=relay-measure
docker image inspect "${COMPOSE_PROJECT_NAME}-app:local" "${COMPOSE_PROJECT_NAME}-maintenance:local" --format '{{index .RepoTags 0}} {{.Size}}'
docker image inspect $(docker compose images -q | sort -u) --format '{{.Size}}' | node -e 'let text=""; process.stdin.on("data", chunk => text += chunk).on("end", () => console.log(text.trim().split(/\s+/).reduce((sum, size) => sum + Number(size), 0)))'
docker buildx du --builder relay-measure-builder
```

`--cold` requires absent project images. It refuses to remove a pre-existing image. The check
removes its containers and volumes, and with `--cold` removes only the project images it created.
It does not clear Docker's shared build cache. Remove a dedicated measurement builder with
`docker buildx rm relay-measure-builder` when finished.

### Read the API

These three POSIX-shell commands use curl and Node.js. The first signs in as a manager and saves a
local cookie file. The second reads Dele's queue. The third finds Jonas's account and reads its
ledger, so it does not rely on an account ID that changes after reset. If you changed the app port,
set `RELAY_ORIGIN` to that app URL before running them.

```sh
(umask 077; curl -fsS -c relay-demo.cookies \
  -H "Origin: ${RELAY_ORIGIN:-http://127.0.0.1:3107}" \
  -H 'Content-Type: application/json' \
  --data '{"role":"manager"}' \
  "${RELAY_ORIGIN:-http://127.0.0.1:3107}/api/auth/demo")
```

```sh
curl -fsS -b relay-demo.cookies --get \
  --data-urlencode 'input={"json":{"agentId":"00000000-0000-7000-8000-000000000102"}}' \
  "${RELAY_ORIGIN:-http://127.0.0.1:3107}/api/trpc/leads.queue"
```

```sh
curl -fsS -b relay-demo.cookies --get \
  --data-urlencode "input={\"json\":{\"id\":\"$(curl -fsS -b relay-demo.cookies --get \
    --data-urlencode 'input={"json":{}}' \
    "${RELAY_ORIGIN:-http://127.0.0.1:3107}/api/trpc/accounts.list" | \
    node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).result.data.json.items.find(a => a.person?.name === "Jonas Weber").id')\"}}" \
  "${RELAY_ORIGIN:-http://127.0.0.1:3107}/api/trpc/accounts.ledger"
```

A tRPC read needs a URL-encoded `input` parameter containing the SuperJSON envelope `{"json":...}`.
`--get --data-urlencode` performs that encoding, including braces and quotes. Sending the inner
object alone is not equivalent. Responses also use SuperJSON, including metadata for dates and
minor-unit bigint values. The manager session may read the queue and ledger; an agent session may
read only its allowed queue and payments and has no ledger access.

The seed follows the funnel's received, pool, contacted and won totals and keeps the board's named
payment stories. Where frames disagree it combines stories, so payment and account lists can have
more rows than one frame. History uses local working hours across the preceding fortnight.
Receipt failures and unknown delivery are invented outcomes; successful receipts go to the SMTP
sink. Leila's receipt uses explicit demo suppression because intake requires an email address.

For a hosted demo, configure `RELAY_DEMO`, `RELAY_SANDBOX`, `AUTH_URL`, `RELAY_SANDBOX_URL`,
`DATABASE_URL`, `SMTP_URL`, `SMTP_FROM`, `RELAY_TIME_ZONE` and the proxy count. Use distinct auth,
webhook, reconcile and outbox secrets. Keep the owner connection in a separate maintenance process.
Point SMTP at a controlled sink. Nothing in this repository publishes or deploys the demo.
Do not publish the mail inbox, because a sign-in code read from it opens a session as any seeded staff member.
Set `AUTH_URL` to the HTTPS origin so the session cookie is marked Secure.
Do not publish PostgreSQL or bind the app or the inbox to all interfaces.

## The money invariant

A completed payment credits its account exactly once through a balanced, immutable ledger posting.
Webhook redelivery, reconciliation and the final manual approval use the same settlement function, so concurrent completion cannot credit it again.

The real-PostgreSQL test [payments.int.test.ts](packages/store/test/payments.int.test.ts),
`a webhook, its duplicate and the reconciler collide and credit exactly once`, holds a database
write gate until every caller has reached it. Run it with
`pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts -t "collide and credit exactly once"`.

The manual collision test in [manual-payments.int.test.ts](packages/store/test/manual-payments.int.test.ts)
forces two approvers to reach the payment write together. Run both proving tests with
`pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts packages/store/test/manual-payments.int.test.ts -t "collide and credit exactly once"`.

A ledger line has a `side` of `debit` or `credit` and a positive amount in minor units.
A posting balances when debits equal credits. Customer accounts are liabilities, so a payment
credits the customer. The card provider and bank are assets, so the payment debits them.
A customer balance is credits minus debits. The database checks both sides against the payment.
Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts`
to check postings and balances.

## Status

All three journeys have a backend and typed API. A lead arrives and is assigned, an agent works
it to won or lost, and a customer makes a payment. There are no CRM journey screens yet.
The repository still has its lead-list scaffold and a plain sandbox checkout form.
Nothing has been published.

What works today:

- Intake from Meta Lead Ads, a web form and CSV uses one race-safe, idempotent operation.
  It creates, attaches, reopens or links a submission without creating duplicate leads.
- Existing staff sign in with an expiring email code. There is no sign-up. Unknown addresses
  receive the same response, get no mail and cannot obtain a session. Codes have limited guesses,
  and PostgreSQL stores request limits across application processes.
- A session starts in its sole team when the user has exactly one membership. With several
  memberships, `session.current` returns the choices. Team-scoped operations require a selection
  and return `teamSelectionRequired` until the user chooses. The server reloads current roles
  and memberships inside each human record operation's transaction.
- `recordScope` in `packages/domain/src/access.ts` decides all record and target-agent scope.
  `scopeAdmits` applies that scope to a record. `scopeWhere` in `packages/store/src/scope.ts`
  only translates it into a SQL filter. Lists and individual operations use those same decisions.
  Agents read and edit their own records. Sales team leads read their team's leads and the pool,
  assign within that team, and edit owned records that their read scope also admits.
  Managers, admins and owners see and edit everything. Accountants read every account, including
  the name and email of the person it was opened for. They cannot read lead records, edit or assign. Edit and assignment scopes always stay within read scope.
- Team leads and management manually assign pool leads, individually or in a batch.
  Round-robin has an immutable preview and a fingerprint. Changed leads invalidate the preview,
  even if a lead returns to its earlier state. A matching idempotency key and request replays the
  stored result. A different request under the same key returns `idempotencyConflict`.
  The planner can exclude previous owners. Reassignment preserves status and follow-up detail.
  Reassigning the current owner returns `changed: false` with no items and writes no history.
- Every changed assignment commits ownership, an activity and an append-only audit row together.
  Intake reopening also audits the removed owner. Audit snapshots are JSON objects, with typed
  subjects, database-enforced actions and a request ID. Distribution audits also reference their
  idempotency receipt. These writes share the operation's serializable transaction.
- A typed tRPC API parses inputs and uses superjson for dates.

`pnpm test` runs unit tests. `pnpm test:int` runs integration tests against real PostgreSQL,
including forced races, catalog checks for unique indexes and grants, and an enabled-trigger
catalog check for every append-only row guard. Owner-connection tests attempt both updates and
deletes on every append-only table.
`pnpm test:prod` checks the production build, SMTP sign-in and scoped API errors.
`pnpm test:mutations <output-directory>` removes each covered safety check in turn, requires its
named test to fail, restores the source in `finally`, and reruns the unchanged tests.

The public form accepts anonymous submissions, including submissions from other origins.
Set `RELAY_PUBLIC_FORM=0` to turn the form route off with a 404 response. It defaults to on.
Run `pnpm exec dotenv -- vitest run --project integration apps/web/test/web-form.int.test.ts` to check the disabled route.
By design, a new enquiry for a lost lead returns it to the pool and removes its owner.
The intake system actor audits that change. No intake source reopens a dead lead, regardless
of whether its reason is duplicate, wrong number or do not contact.

`pnpm test:int -- apps/web/test/web-form.int.test.ts` verifies the form's shared PostgreSQL limits.
Each client may make 10 requests per 60-second fixed window. All clients share a separate
1,000-request window. A refused request returns 429 with `Retry-After: 60` and records no intake.
A client refused by its own budget does not consume the global budget. Invalid submissions count.
The window starts with the first request and resets on the first request after expiry.
The shared counter uses one conditional PostgreSQL upsert. In that same statement, it removes at
most 100 other expired windows, with locked rows skipped. Each window stores its duration, so
cleanup preserves longer windows. `pnpm exec dotenv -- vitest run --project integration packages/store/test/distribution-contract.int.test.ts`
checks the cleanup bound and duration handling. The row lock serializes increments
and refuses increments past the budget. `pnpm test:int -- packages/store/test/distribution-contract.int.test.ts`
checks concurrent admission, saturation and expiry.

`RELAY_TRUSTED_PROXY_COUNT` defaults to 0. `pnpm test -- apps/web/test/client-address.test.ts`
checks that 0 ignores all forwarded headers and uses the TCP peer. A positive setting selects
that many hops from the right of `X-Forwarded-For`. An invalid address or a shorter chain falls
back to the TCP peer. When `RELAY_TRUSTED_PROXY_COUNT` is above zero, the app's port must be
reachable only through the proxy. A direct connection can forge the forwarded header, so enforce
that restriction with the deployment's network rules. Configure the exact proxy count. Each proxy
must append the peer address or overwrite the header with a verified chain.
IPv4-mapped IPv6 and IPv6 spellings are canonicalized before counting.

Use `pnpm dev` and `pnpm start`. Development always binds `127.0.0.1`. Production uses `HOST`,
defaulting to `0.0.0.0`. `pnpm test -- apps/web/test/env.test.ts` checks those choices. Their Node HTTP entry point captures the connection address
in request-local storage before Next handles the request. Running `next start` directly lacks
that context. A request without either a socket address or a trusted forwarded address is refused
with the fixed error response. The server logs the missing-address configuration error once.
No shared fallback budget is created. `pnpm test:prod` checks this through plain `next start`.
`pnpm test -- apps/web/test/env.test.ts` checks that the proxy count is an integer from 0 to 32.

## How it is built

`pnpm -r list --depth -1` lists the workspace packages. Each one holds one kind of knowledge.

| Package           | What it knows                                                  | What it must not do                 |
| ----------------- | -------------------------------------------------------------- | ----------------------------------- |
| `packages/domain` | The rules: lead states, access scopes, email identity, intake  | Import a dependency, read the clock |
| `packages/store`  | Every SQL statement and every transaction                      | Export the Prisma client            |
| `apps/web`        | HTTP: intake, authentication, payment routes and the lead list | Depend on a database client         |

The build enforces the right-hand column. The domain declares no dependencies and loads no ambient
types, so `process`, `fetch` and `node:*` do not typecheck there. Lint forbids `Date.now()` and
`Math.random()` in it. The web app has no database client to import, so it can only reach data
through the operations the store exports.

### How intake stays correct under concurrency

`resolveIntake` in the domain is a pure function. It takes what the database holds for a
submission and returns one decision. `store.intake` loads that snapshot, calls the function and
writes the result, all inside one `SERIALIZABLE` transaction.

When two transactions decide on the same stale snapshot, PostgreSQL fails one of them. The store
retries it from the start with a random delay, and the next run sees
the first one's rows. Unique indexes on the email address and on the source and external ID still
apply to a writer that bypasses the store.

The alternative was READ COMMITTED with a lock per email. That needs every later feature that
writes a lead to take the same lock. With `SERIALIZABLE`, one rule covers every writer, and the
cost is retries when submissions collide.

The database also enforces the lead state by itself. A CHECK constraint admits exactly the column
combinations the `LeadState` union has, and refuses a status it does not know. Triggers make the
intake ledger and the activity timeline append-only.

## Run it

Use the Node.js and pnpm versions declared in `package.json`, and a dedicated PostgreSQL server.

1. Install the dependencies and generate the Prisma client.

   ```sh
   pnpm install
   pnpm db:generate
   ```

2. Copy `.env.example` to `.env` and set `DATABASE_URL` and `MIGRATION_DATABASE_URL`. Clear the placeholder `AUTH_SECRET`
   to keep sign-in off, or replace it with a generated secret before enabling sign-in. Use a dedicated database:

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

   The app has schema usage and sequence usage. The tables below list its table grants and
   additional column updates. Memberships, teams and email suppressions are read-only.
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
| `pnpm lint`                              | Runs ESLint with type-aware rules                               |
| `pnpm format:check`                      | Checks formatting with Prettier                                 |
| `pnpm typecheck`                         | Typechecks every package and its tests                          |

The integration tests create a template database and one database per test, and drop each test's
database when the test ends. Only `MIGRATION_DATABASE_URL` needs `CREATEDB`.
The app and test operations use the restricted `DATABASE_URL` role. Test fixtures use an explicit
owner connection to create schemas, set up fixture rows, install failure triggers, restore marked
demos and verify owner-level defences.
Database test files run sequentially.

## Sign in and assign through the API

Staff users and their memberships must already exist. There is no provisioning screen.
Set `AUTH_SECRET` and `AUTH_URL` to enable sign-in. Set `SMTP_URL` and `SMTP_FROM` to deliver codes
through SMTP. Without SMTP, only development can enable sign-in and print a code to the console.
Production refuses that configuration. A build reads no auth configuration and needs no database.

Request a code at `POST /api/auth/email-otp/send-verification-otp` with
`{"email":"staff@example.com","type":"sign-in"}`. Submit it to `POST /api/auth/sign-in/email-otp`
with `{"email":"staff@example.com","otp":"123456"}`, then keep the session cookie.
Send JSON and an `Origin` header matching `AUTH_URL` on auth and tRPC mutations.
`POST /api/auth/sign-out` ends the session. Other auth endpoints are closed except session read.
Sign-in code delivery runs after the response. It keeps its own mailer path and does not enter the receipt outbox.

The tRPC router is exported as `AppRouter` from `apps/web/src/server/rpc.ts`.
It serves these operations under `/api/trpc`:

- `leads.list`, `leads.get` and `leads.edit` read or update contact fields within scope.
- `accounts.list` and `accounts.get` read accounts within scope. Account writes are not exposed yet.
- `leads.assign` assigns pool lead IDs to an agent's sales team. `leads.reassign` keeps the lead's status.
- `distribution.preview` takes lead IDs, chosen agents and `excludePreviousOwner`.
- `distribution.submit` takes `previewId`, `fingerprint` and an idempotency `key`.
  Keys belong to the authenticated user. The same key, operation and request hash return exactly
  the stored first result, including its original owners, after a role or scope change.
  A valid session for that same actor is still required. Another actor cannot replay its receipt.
  Different input or a different operation returns `idempotencyConflict` with the message
  "The key was already used for a different request."
- `session.current` returns the principal, current team and available memberships.
- `session.selectTeam` selects a current membership or clears it. A sole membership is selected
  again on the next session load. An unselected user with several memberships must choose before
  using team-scoped operations.

Out-of-scope records return access denied. A changed preview returns a typed conflict.
The API error includes `data.accessFailure` for these domain refusals.

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

## Intake sources

### Meta Lead Ads

Set the four `META_` variables in `.env` and point the Meta webhook at `/api/intake/meta`. When the
variables are unset, the route answers 404.

| Request                                    | Response                                     |
| ------------------------------------------ | -------------------------------------------- |
| `GET` with the right `hub.verify_token`    | 200 and the `hub.challenge` value            |
| `GET` with any other token                 | 403                                          |
| `POST` with a valid `X-Hub-Signature-256`  | 200 once every lead in the batch is recorded |
| `POST` with a missing or wrong signature   | 401                                          |
| `POST` that is signed but fails to process | 500, so Meta delivers it again               |

The signature is an HMAC-SHA256 of the raw body, compared in constant time. A redelivery is safe,
because leads that were already recorded replay.

### Web form

`POST /api/intake/form` takes JSON or a URL-encoded form.

| Field          | Required | Meaning                                                        |
| -------------- | -------- | -------------------------------------------------------------- |
| `email`        | Yes      | The person's email address                                     |
| `submissionId` | No       | A UUID the form creates when it renders. It makes a retry safe |
| `name`         | No       | The person's name                                              |
| `phone`        | No       | A phone number, stored as typed                                |
| `form`         | No       | A label for the form                                           |
| `campaign`     | No       | A label for the campaign                                       |

The endpoint answers 202 for every recorded submission, 422 for an invalid email with a message
that says what to fix, and 503 with `Retry-After` when the database could not record the submission.

### CSV

`pnpm import:csv leads.csv` needs a header row with an `email` column. The optional columns are
`name`, `phone`, `campaign`, `ad_set`, `ad`, `form` and `external_id`. Running the import again on
the same file records nothing new. If you correct one row and import again, only that row is new.

## Roadmap

The planned journeys are:

1. A lead arrives, a manager or team lead assigns it from the pool, and it lands in an agent's queue.
   Intake, sign-in, scope, assignment and the queue API work. The screens are not built.
2. The agent works the lead to won or lost through the typed API. The work screens are not built.
3. A payment credits its account exactly once through a balanced ledger posting. Card webhooks and
   reconciliation share settlement with the final manual approval. Notifications use an outbox.
   Card payments, manual approvals, the ledger, reconciliation and email receipts work through
   the API. Payment screens are not built.

Other work not built:

- A general email connector beyond sign-in codes and payment receipts.
- The audit viewer.
- Quota distribution.
- Whitelabel theming.
- CSV export. CSV intake already works.
- Google sign-in.
- The daily pool job.
- Payment reversal.
- Tasks.

## License

MIT. See [LICENSE](LICENSE).

## Sign-in request limits

`pnpm test:int -- apps/web/test/auth.int.test.ts` verifies these PostgreSQL budgets.
All use 60-second fixed windows and return the same 429 body and `Retry-After: 60` for known
and unknown email addresses. Timing padding also applies to a refused request.

The client address has 20 requests across code issuance and verification. Code issuance has
3 requests per normalized email address. Verification has 10 per normalized email address.
Client identity follows `RELAY_TRUSTED_PROXY_COUNT`, just as the form does.
The client budget is checked first, then the email budget, then the global circuit breaker.
A refusal stops those checks, so it cannot consume the later budgets.

`RELAY_AUTH_GLOBAL_LIMIT` defaults to 10,000 requests per window across both operations.
`pnpm test -- apps/web/test/env.test.ts` verifies that its configured value is an integer from
21 to 1,000,000. Its minimum stays above a single client's budget.

## Error responses

`pnpm test:int -- apps/web/test/rpc.int.test.ts apps/web/test/auth.int.test.ts` verifies that
unexpected failures return `Something went wrong.` and a generated `requestId`. The server
logs the error class and code with that ID, without its message or submitted data.
The tRPC formatter preserves typed domain failures in
`data.accessFailure` and their messages. It removes stack traces from every error response.
The auth and intake HTTP boundaries catch unexpected exceptions. The form keeps its retryable
503 response for intake failures, with the same fixed message and a logged request ID.

## Request body limits

`pnpm test -- apps/web/test/http.test.ts` verifies the shared streaming reader's exact boundary.
Auth, tRPC and the public form accept at most 100,000 body bytes and return 413 above that limit.
The reader checks the declared length first, then counts actual bytes, including chunked bodies,
and cancels the stream when the limit is exceeded. Auth and tRPC parse only the bounded copy.
`pnpm test:prod` sends JSON containing 2,000,000 padding characters to those routes, including sign-out, and expects 413.
The signed Meta webhook keeps its separate 1,000,000-byte limit, checked by
`pnpm test -- apps/web/test/meta-webhook.test.ts`.

## Generate an authentication secret

Generate a secret locally, then put it in your deployment environment and untracked `.env`.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`pnpm test -- apps/web/test/env.test.ts` verifies that `AUTH_SECRET`, `RELAY_PAYMENT_WEBHOOK_SECRET`,
`RELAY_RECONCILE_SECRET` and `RELAY_OUTBOX_SECRET` each need at least
32 characters and 12 distinct characters, and refuses the exact placeholder in `.env.example`.
Configured secrets must be pairwise distinct. These checks reject obvious weak values. They do not measure entropy. Use the generator rather
than a phrase that happens to pass the checks. `pnpm test:prod` verifies startup refusal for a
repeated-letter secret and for the placeholder. Empty `AUTH_SECRET` leaves sign-in off when
`AUTH_URL` and SMTP are also unset.

## Working a lead

The queue reads all of an agent's open leads with their activity history on each request, then applies the per-group limit.

Only agents have a work queue. A sales team lead can view an agent's queue on their selected team.
Managers, admins and owners can request any agent's queue. Each row still passes the viewer's
record read scope. The default target is the signed-in agent.

Every open lead owned by that agent appears in exactly one of five groups. The server supplies
the current instant and `RELAY_TIME_ZONE`, the organisation's IANA time zone, which defaults to UTC.

- `overdueCallbacks` holds callbacks before the current instant, including earlier today.
- `dueToday` holds remaining callbacks on the current local calendar day.
- `noCallbackSet` holds leads with a recorded attempt in their current assignment and no callback.
- `notYetCalled` holds leads with no recorded attempt since their current assignment and no callback.
- `later` holds callbacks after the current local calendar day.

Callback groups are ordered by callback time, soonest first. `notYetCalled` is ordered by the
current assignment time, newest first. Notes do not count as attempts. Reassignment and assignment
after reopening start a new attempt window. Rows include the intake `source`, campaign and
`assignedAt`. `limit` bounds each group. `counts` gives each full group count and `nextCallbackAt`
gives the earliest future callback, including one due later today.
Run `pnpm test -- packages/domain/test/work.test.ts` for the five-group property and the organisation's
midnight boundary. Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/work.int.test.ts`
for scoped queues, reassignment, reopening and local-day boundaries in Tokyo and Los Angeles.

The typed API exposes these writes. Each takes a lead `id` and an idempotency `key`:

- `leads.logAttempt` takes `channel` of `call` or `whatsApp`, `outcome` of `noAnswer` or
  `spokeToThem`, and a nonempty `note`. An optional `callback` saves with the attempt.
- `leads.addNote` takes a nonempty `note`.
- `leads.setCallback` takes `change` of `{ kind: "set", at: Date }` or `{ kind: "clear" }`.
  Setting also moves an existing callback. The time must be in the future.
- `leads.close` takes a `closing` union. `won` has no reason. `lost` takes only a nonempty written `note`. `dead` takes `duplicate`, `wrongNumber` or `doNotContact`.

Only `spokeToThem` records contact. A call or WhatsApp attempt alone does not.
The transition table decides the working stage. Clearing a callback moves a lead that was waiting
on it to working in `ready`, without claiming contact. Clearing an unset callback returns
`callbackNotSet` and writes no history. `noAnswerCount` on the queue and detail counts the recorded
no-answer attempts across callbacks. Every lead in this schema has recorded work history. The `noAnswer` stage's `count` is the consecutive count from
the transition table. Setting a callback replaces that stage, but preserves the attempt history.

An agent can work their own lead. Anyone else needs its existing edit scope. A team lead's team
read scope does not grant edits to a teammate's lead. Closed leads refuse further work.
Winning or losing requires a working lead. A wrong-number close requires a recorded attempt in
the current assignment, including after reassignment. Otherwise it returns `wrongNumberNeedsAnAttempt`
with a message asking the agent to try contacting the lead first. Duplicate and do-not-contact
closures also work before an attempt.
Every accepted write commits its activity and audit with the acting user and HTTP request ID.
A replay rechecks current access and adds no history. Reusing a key with different input refuses
with `idempotencyConflict`.

Winning creates an account owned by the lead's current agent and team in the same serializable
transaction. The global lead email identity and `leads_account_id_key` link that person to an
account. The `leads_state_shape` CHECK requires a won lead to have an account, and its foreign key
requires that account to exist. A competing win retries the whole transaction and returns the
existing account. It creates no further account or closing activity. A later enquiry for that
person links to the account through intake. Run
`pnpm exec dotenv -- vitest run --project integration packages/store/test/work.int.test.ts`
for the forced win collision, win against reassignment, close against intake and direct SQL refusal.
The database refuses every status change out of won or dead. A lost lead can only return to new
with its previous owner recorded and a new reopening intake event in the same transaction.
Intake attachments update the lead before appending history so their sequence reflects the order
of the lead decisions.

`leads.get` includes custody, original attribution and the timeline in descending database sequence.
Custody gives the original intake source and receipt time, the latest assigner and assignment time,
and the current holder. Missing custody is null. Timeline entries include actor names,
the submitted command and the request ID. Attempt summaries return `callbackAt` as a date and
`noAnswerCount` at that entry. Activity snapshots are JSON objects. Entries remain append-only.

`contactedAt` is null when no contact is recorded. The timeline retains each observed attempt
at its recorded time.

## Campaign funnel and accounts

`reports.funnel` is available to managers, admins and owners. Accountants, agents and team leads
cannot read it. It returns `rows`, `campaignCount` and `otherSourceCount`. Each row groups the
original intake source and campaign, so a form and an ad with the same campaign name stay separate.
Each row gives leads received, still unassigned, contacted,
won and conversion as won divided by received. It counts each lead once under its creating intake,
including leads later closed as dead and leads later reopened or reassigned. Repeat submissions and enquiries linked to accounts add no received
leads. Leads without recorded attribution have null source and campaign. `campaignCount` counts
named Meta Lead Ads campaign rows. `otherSourceCount` counts distinct remaining sources, including
unattributed leads as a null source. A Meta Lead Ads row without a campaign is also an other source.

A campaign's `contacted` counts leads with a recorded conversation. An unanswered attempt does not count.

`accounts.list` returns `items` and the scoped `total` before the limit. It orders by the person's
name, then email, then account ID. Each item includes the owner, the person's name and email,
and the creating intake's campaign. An accountant can read this identity without access to lead
records. Every caller who can list an account can also read its payment summary. `paymentCount`
counts completed payments, and `paymentInProgress` is the state of a pending approval or card checkout,
or null when none is in progress. The existing payment decoder supplies the states.

Callers who may read the ledger also receive `balances` by currency from the existing ledger
reader. Agents and team leads receive `balances: null`. An account without ledger entries has an
empty balance list. There is no stored balance or separate balance calculation.
Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/work.int.test.ts apps/web/test/rpc.int.test.ts`
for role scope, account balances, boundary parsing and request correlation.

Run `pnpm test:mutations <output-directory> work-` to remove the selected work checks in turn,
require each named test to fail, restore its source and rerun the baseline.
Run `pnpm test:prod` for the signed-in production journey. Its `LIVE_WORK` output records form
intake, manager assignment, the agent's queue, no answer, a callback, confirmed contact, a win,
and read-back of the timeline, account and funnel. `LIVE_QUEUE_FIXES` records a worked lead
remaining in the queue, reassignment, reopening and assignment, written lost closure, a dated
timeline callback, separate intake sources and the manager and agent account responses.

## Payments and receipts

A payment credits its account exactly once. Webhooks, reconciliation and the final manual approval
call one settle function. It writes the payment, balanced ledger posting, audit and completion
outbox row in the same transaction. The [card race](packages/store/test/payments.int.test.ts) and
[manual approval race](packages/store/test/manual-payments.int.test.ts) exercise this on PostgreSQL.
Run them with `pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts packages/store/test/manual-payments.int.test.ts -t "collide and credit exactly once"`.

Someone holding the app's database credentials can record approvals in two eligible people's names and complete a manual payment, because the database checks who is named as approver and not who is connected.
Someone holding the app's database credentials can change a closed lead's owner or account, or reopen a lost lead by inserting an intake event, because the database guards status changes and not the intake's origin.
Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/payment-guards.int.test.ts packages/store/test/work.int.test.ts -t "database credentials"` to check these limits.

### Card payments

Sandbox payments are off by default. Set `RELAY_SANDBOX=1`, `RELAY_SANDBOX_URL` to the app's HTTP
origin, and distinct `RELAY_PAYMENT_WEBHOOK_SECRET` and `RELAY_RECONCILE_SECRET` values. The sandbox
moves no real money. A production build refuses sandbox startup without `RELAY_DEMO=1`.
With that setting, payment API responses and account ledger responses carry `demo: true` for
screens to show a demo banner. The flag is false otherwise. `pnpm test -- apps/web/test/env.test.ts`
and `pnpm exec dotenv -- vitest run --project integration apps/web/test/payments.int.test.ts`
check the startup rule and response flag. The sandbox stores its checkout status separately from the CRM payment and signs
webhooks over the timestamp, a period and the raw body with HMAC-SHA256.

`payments.createCheckout` takes `accountId`, a request `key`, `amount` as a positive integer string
in minor units, `currency`, `kind` of `first` or `repeat`, and an optional sandbox `mode`.
Modes are `normal`, `drop`, `twice`, `late` and `differentAmount`. The last reports an amount greater
than the requested amount. The returned checkout URL has a plain pay form. The account's existing
edit scope decides who may create it. The request receipt is immutable; a replay can retry provider
checkout creation after an interrupted request. The provider gives each checkout its own random ID.
The pay URL contains a random bearer token. Only its SHA-256 hash is stored. Only the authorized
creation response returns the URL. Later reads and creation replays return no token or pay URL.
If that response is lost after provider creation, close the waiting payment and create another.
Creation replays recheck current account edit access.
`pnpm exec dotenv -- vitest run --project integration apps/web/test/payments.int.test.ts` checks
that an accountant cannot pay with a disclosed payment ID, and that tokens use 32 random bytes.
`recordedById` and `soldById` are fixed at creation.

`payments.list` groups scoped results as `waitingForApproval`, `waitingForProvider`, `needsReview`
and `decidedThisWeek`.
The last group uses the UTC calendar week. `limit` bounds each group. `counts` gives each full
scoped group total before that limit. `payments.get` returns the customer in `account`, the
attributed agent in `soldBy`, and `providerReference`, the checkout ID returned by the provider.
It also returns state and an event log ordered by its database sequence. Each accepted webhook delivery has an event,
including duplicates and late arrivals, with the observed money and whether state changed.
It includes the posting only for accountants, managers, admins and owners. Those roles can call
`accounts.ledger`, whose entries and running balances come from immutable lines, grouped by currency.
An empty ledger has no currency balances. Agents can read their own payments but receive no posting
and cannot read the ledger endpoint.

The SERIALIZABLE settlement function re-reads the payment. Matching provider money can complete it.
Mismatched amount or currency moves it to `needsReview` without a posting. `payments.closeReview`
takes an ID and a written reason; accountants and management may close review as `failed`.
The audit preserves the reported money and the review reason, either `amount mismatch`,
`currency mismatch` or `paid after close`. Review has no transition to completed.
A paid report after `expired` or `failed` moves the payment to `needsReview` without credit.
That is the only exit from either closed state. `completed` has no exit.

`payments.closeCheckout` lets an account editor close a waiting checkout as `failed` with a written
reason. When sandbox payments are enabled it then cancels the provider checkout.
When they are disabled it records that the provider was not asked. Reconciliation resumes when
they return. If the provider reports that it was already paid, the same request moves it to review.
A paid report from either a late webhook or the reconciler also moves a closed payment to review.
The reconciler watches closed card payments until the provider reports a final state.
An active creation request has a token and a 30-second deadline. Only its owner can finish it.
Reconciliation waits for creation to finish or its deadline to pass, even when the first check delay is zero.
The provider refuses creation after the payment leaves `checkoutCreated`. Unknown provider checkouts fail with `the checkout was never created at the provider`.
Checkouts expire after `RELAY_CHECKOUT_TTL_MS`, default 86400000 milliseconds.
Run `pnpm exec dotenv -- vitest run --project integration apps/web/test/payments.int.test.ts`
for expiry, missing checkouts and staff closure.

PostgreSQL checks the payment state shape and transitions. Deferred constraint triggers require a
completed payment to have a posting with balanced lines matching its account, currency and amount,
and exactly one outbox row. Outbox rows cannot be deleted, truncated or moved to another payment.
The unique payment index refuses another posting. Triggers refuse updates, deletes and truncation on ledger
accounts, postings and lines. Settlement writes the state, posting, audit and `paymentCompleted`
outbox row in the same transaction. The worker delivers the receipt after commit.
A replay writes no new state, posting, audit or outbox row; delivery/check history remains observable.

Run `pnpm reconcile` using the repository environment. A scheduler can instead send
`POST /api/payments/reconcile` with `Authorization: Bearer <RELAY_RECONCILE_SECRET>`.
The reconcile HTTP route returns only `checked` and `changed` counts. The outbox HTTP route returns
only `processed`, `sent`, `failed`, `suppressed`, `unknown`, `superseded` and `recordingFailed` counts. Neither returns record IDs.
`pnpm exec dotenv -- vitest run --project integration apps/web/test/payments.int.test.ts` verifies that.
`pnpm exec dotenv -- vitest run --project integration apps/web/test/job-routes.int.test.ts packages/store/test/jobs.int.test.ts`
checks both HTTP routes. Each allows five failed authentication attempts per client address per
60-second window, then returns 429 with `Retry-After: 60`. Valid secrets do not consume that failed
attempt budget. The route guard only stops overlapping scheduled calls to the same route.
An overlapping call returns 429. The outbox and reconcile routes use separate lease rows, with
leases of 15 seconds for reconciliation and 60 seconds for the outbox, renewed every third of their
lease while they run. The database clock sets and checks expiry. Finishing or failing releases the caller's lease token.
A stopped caller's lease expires. The callback holds no transaction open and is never retried
by the guard. `pnpm exec dotenv -- vitest run --project integration packages/store/test/jobs.int.test.ts`
checks expiry, token ownership and the absence of a transaction during the callback.

The command-line jobs do not acquire the route guard. Every entry point protects individual rows.
Reconciliation conditionally claims each due payment and checks its claim token before settlement.
The outbox leases each receipt using the database clock and skips rows held by another sender.
Settlement still enforces the single posting when competing jobs observe the same payment.

Both reconcile entry points scan candidates outside settlement, then claim each due payment with a conditional update.
A competing job that loses the claim skips the provider call. The claim moves `nextCheckAt` forward,
so a stopped job becomes eligible again. Provider read errors record an unsuccessful check and
leave the payment for its next check. Provider failures and expiry close the payment without credit.

`pnpm test -- apps/web/test/env.test.ts` verifies the timing defaults. `RELAY_RECONCILE_FIRST_MS`
defaults to 900000 and `RELAY_RECONCILE_INTERVAL_MS` to 300000. `RELAY_SANDBOX_LATE_MS` defaults to 30000. For a local interview run, set the first delay to zero and the late delay long enough to
call the reconciler before delivery. Signature, timestamp tolerance and replay behavior run in
`pnpm exec dotenv -- vitest run --project integration apps/web/test/payments.int.test.ts`.

Sandbox delivery runs after the pay response in the serving process. A process exit can lose that
delivery; reconciliation recovers the completed provider status. This is a sandbox failure mode,
not a durable notification worker. `pnpm test:prod` signs in an agent through SMTP, submits the
sandbox form, reconciles a late delivery, and checks duplicate delivery and an amount mismatch
through the production API. Its `LIVE_PAYMENT` output records each event log, posting and balance.

### Manual payments

`payments.recordManual` takes `accountId`, an idempotency `key`, positive minor-unit `amount`,
`currency`, `kind`, a `receiptHash` of 64 lowercase hexadecimal characters and an optional
`reference`. The caller supplies the hash. The app compares it as a string to prevent the same
receipt being entered twice by mistake. It stores no receipt file, does not check that a file
exists, and does not prove that a transfer happened. Two independent approvers checking the
payment are the control. Two approvers acting together can approve a fabricated receipt.

The owning agent or another person with account edit access may record a payment. It starts in
`pendingApproval`. One partial unique index allows one payment in progress per account across
`pendingApproval` and `checkoutCreated`. A second manual payment or card checkout returns
`pendingPayment` with "This account already has a payment in progress."
Another index allows one live manual payment per receipt hash. Rejected and cancelled payments
release the hash. A person who already holds a receipt hash and can submit a payment can learn
whether a live payment uses it, because `receiptUsed` must explain the duplicate refusal.
Reusing the original request key replays its stored result.

`payments.approve` takes `id`, the displayed terms `version` and the signed-in person's
`roleVersion` from `payments.get`. Two different accountants, managers, admins or owners must
approve. Neither the recorder nor anyone who edited the terms may approve. The second
approval calls settlement inside its approval transaction. Manual settlement debits
"Bank transfers and cash" and credits the customer. There is no posting before the second approval.

Each approval records its approver, role version, payment version and time. A role-change trigger
increments the user's role version and voids that person's approvals on waiting payments.
Completed payments keep their historical approvals. The approving transaction reloads both
approvers' roles and versions. The database checks eligibility on approval insert and independently
requires two current approvals from people other than the makers at completion. User emails are
unique ignoring case.

`payments.editManual` accepts money, receipt hash and reference while the payment waits. The
account is immutable. The edit checks the displayed version, adds the editor to the append-only maker set, increments
the version and voids every active approval in the same transaction. Earlier approvals therefore
cannot approve the new terms. Editing and approval serialize on the payment. A request whose
terms version became stale must refresh.

`payments.get` and `payments.list` include the recorder, approval history and the
signed-in person's actions. Typed errors include `pendingPayment`, `receiptUsed`, `paymentRecorder`,
`paymentMaker`, `alreadyApproved`, `roleChanged` and `refreshConflict`.
`payments.reject` and `payments.cancel` take `id`, `version` and a nonempty written `reason`.
Only the recorder may cancel. Only someone with approval access who is not a maker may reject.
Both decisions are final and credit nothing. Events and audits retain the actor, reason and request ID.

Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/manual-payments.int.test.ts packages/store/test/payment-guards.int.test.ts`
for approval races, maker refusals, role versions, term changes, account and receipt collisions,
standalone truncate guards, direct SQL refusals and active-approval uniqueness.
`pnpm test:mutations <output-directory> <name-prefix>` removes the selected guards, requires their
named behavior tests to fail, restores the source and reruns the baseline. The optional prefix
selects mutations such as `payment-`, `receipt-lease` or `truncate-`.

### Receipt delivery

Run `pnpm outbox` with the repository environment. It uses `SMTP_URL` and `SMTP_FROM` and needs
no sign-in settings. `pnpm exec dotenv -- vitest run --project integration apps/web/test/payments.int.test.ts -t "outbox command"`
checks SMTP delivery without sign-in settings. A scheduler
can call `POST /api/payments/outbox` with `Authorization: Bearer <RELAY_OUTBOX_SECRET>`.
The route is disabled without its secret or SMTP configuration. Sign-in codes keep their direct
mailer path.

The worker claims due rows with `FOR UPDATE SKIP LOCKED` and stores a lease token and expiry.
An unexpired lease prevents another lease or a requeue. Sending happens outside the transaction.
The worker aborts each send within `RELAY_RECEIPT_SEND_TIMEOUT_MS`, default 30000 milliseconds,
including time spent preparing its attempt. `RELAY_RECEIPT_LEASE_MS` defaults to 60000 milliseconds.
Settings refuse a send timeout that is not shorter than the lease. The SMTP transport closes its
connection on abort. The database clock sets and checks every lease expiry. The lease and timeout exclude simultaneous
sends through the shipped SMTP adapter even if the worker's database session disappears. There is no session advisory lock.

Delivery is at most once per attempt. A crash after leasing but before recording an attempt leaves
a pending row that becomes eligible after lease expiry. A crash between recording the attempt and
the send leaves the receipt unsent until a person requeues it. A crash after the send leaves a sent
receipt marked `unknown`. Once the sent outcome commits, the worker will not retry it.
A duplicate needs a person to requeue a receipt that had in fact arrived.

| State        | Behavior                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sent`       | SMTP confirmed acceptance. No retry. Acceptance does not prove inbox placement.                                                                                                                         |
| `suppressed` | The address is suppressed, or no address exists. No send or retry. A missing address records "no address".                                                                                              |
| `failed`     | A failure before DATA, including connection refusal, DNS failure and greeting timeout, or a clear SMTP refusal. Retries after 5, 10 and 20 minutes, up to four attempts per cycle and the lifetime cap. |
| `unknown`    | DATA was sent without a clear answer, or the worker stopped before recording the outcome. No automatic retry.                                                                                           |

The SMTP adapter observes whether message data started. A connection error's command can still be
`CONN` after DATA, so its code alone cannot establish that retrying is safe. If recording one
outcome fails, the worker leaves the attempt unknown, records a `receiptRecordingFailed` event and
continues the batch. If the database also refuses that event, the worker result says the failure
could not be recorded. A lost lease token produces `superseded`, not a claim that the send was recorded.

`RELAY_RECEIPT_LIFETIME_ATTEMPTS` defaults to 12. Automatic retries and manual requeues share this
limit. The payment API returns receipt state, recipient, attempts, history and the next retry time.
Accountants, managers, admins and owners may call `payments.requeueReceipt` with a payment `id`
for a failed or unknown receipt whose lease has ended. Every accepted requeue records an audit and
event, starts a new retry cycle and preserves the lifetime attempt count. At the cap, it returns
`receiptAttemptLimit` with "This receipt has reached its lifetime attempt limit."
Receipt delivery never changes payment completion or the ledger. The app can update only outbox
state, the retry-cycle counter, lease fields and next-attempt time. It cannot change a recipient,
receipt identity or lifetime count. Inserting a positive numbered receipt attempt advances the
lifetime count through an owner trigger. Its number must be the next lifetime attempt. It can finish an attempt by
updating its state, reason and finish time, and cannot renumber it or change its start time.
Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/database-role.int.test.ts packages/store/test/outbox.int.test.ts`
for the effective column grants and direct SQL refusals.

Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/outbox.int.test.ts`
for retry timing, attempt limits, worker collisions, database-session loss, suppression, failed
outcome recording and audited requeue. `pnpm exec vitest run --project unit apps/web/test/mailer.test.ts`
uses local SMTP and DNS servers for acceptance, refusal, timeouts and connection loss. Every attempt
uses the same Message-ID derived from the outbox ID. A mail server may deduplicate it, but SMTP
does not guarantee exactly-once delivery.

`pnpm test:prod` signs people in through a local SMTP receiver and exercises the production HTTP
API in demo mode. Its `LIVE_MANUAL` output records an editor's refused approval, completion by two
other people, a card checkout refused while a manual payment waits, a refused SMTP connection,
delivery after the receiver restarts, suppression, unknown delivery and a lifetime-cap refusal.
The retry test checks the stored delay, then makes only its fixture row due to avoid waiting.

### Known limits

Someone holding the app's database credentials can change a lead's email and aim a future receipt, but cannot change the recipient of an existing receipt. Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/database-role.int.test.ts -t "aim a future receipt"` to check both with direct SQL as the app role.

Someone holding the app's database credentials can complete a card payment directly in SQL with a valid posting, because the database checks the posting's shape and not the provider's evidence.

A delivery adapter that ignores its abort signal can still be sending after its timeout, and a requeue can then start a second send. The shipped SMTP adapter closes its connection on abort.

A receipt whose preparation outlasts the send timeout is marked `unknown` without being sent, and needs a person to requeue it.

A provider report of pending, failed or expired with a different amount also enters review as a mismatch.

Someone holding the app's database credentials can add makers or attribute a SQL edit to another person, but cannot remove existing makers.

`accounts.ledger` returns each entry's `completion` with `by` and `at`. A manual completion also
includes the second approver's name in `approver`, read from the final ordered approval event. System
completions identify `reconciler` or `providerWebhook`. The reader batches payments, approval events,
people and postings without a query per payment. Agents still receive no ledger or balance.
Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/payment-reads.int.test.ts`
for detail fields, scoped group totals, completion provenance and query counts with one payment and several payments.

### Application grants

| Table                   | Privileges                             |
| ----------------------- | -------------------------------------- |
| `accounts`              | `INSERT`, `SELECT`                     |
| `activities`            | `INSERT`, `SELECT`                     |
| `audit_log`             | `INSERT`                               |
| `auth_accounts`         | `DELETE`, `INSERT`, `SELECT`, `UPDATE` |
| `auth_request_limits`   | `DELETE`, `INSERT`, `SELECT`, `UPDATE` |
| `auth_sessions`         | `DELETE`, `INSERT`, `SELECT`, `UPDATE` |
| `auth_verifications`    | `DELETE`, `INSERT`, `SELECT`, `UPDATE` |
| `demo_seed`             | `SELECT`                               |
| `distribution_previews` | `INSERT`, `SELECT`                     |
| `email_suppressions`    | `SELECT`                               |
| `idempotency_records`   | `INSERT`, `SELECT`                     |
| `intake_events`         | `INSERT`, `SELECT`                     |
| `job_leases`            | `INSERT`, `SELECT`, `UPDATE`           |
| `leads`                 | `INSERT`, `SELECT`, `UPDATE`           |
| `ledger_accounts`       | `INSERT`, `SELECT`                     |
| `ledger_lines`          | `INSERT`, `SELECT`                     |
| `ledger_transactions`   | `INSERT`, `SELECT`                     |
| `memberships`           | `SELECT`                               |
| `outbox`                | `INSERT`, `SELECT`                     |
| `payment_approvals`     | `INSERT`, `SELECT`                     |
| `payment_events`        | `INSERT`, `SELECT`                     |
| `payment_makers`        | `INSERT`, `SELECT`                     |
| `payments`              | `INSERT`, `SELECT`, `UPDATE`           |
| `receipt_attempts`      | `INSERT`, `SELECT`                     |
| `sandbox_checkouts`     | `INSERT`, `SELECT`, `UPDATE`           |
| `teams`                 | `SELECT`                               |
| `users`                 | `INSERT`, `SELECT`, `UPDATE`           |
| `webhook_inbox`         | `INSERT`, `SELECT`                     |

| Column                         | Additional privilege |
| ------------------------------ | -------------------- |
| `outbox.cycle_attempts`        | `UPDATE`             |
| `outbox.lease_token`           | `UPDATE`             |
| `outbox.lease_until`           | `UPDATE`             |
| `outbox.next_attempt_at`       | `UPDATE`             |
| `outbox.state`                 | `UPDATE`             |
| `payment_approvals.voided_at`  | `UPDATE`             |
| `receipt_attempts.finished_at` | `UPDATE`             |
| `receipt_attempts.reason`      | `UPDATE`             |
| `receipt_attempts.state`       | `UPDATE`             |

## Lead screens and browser checks

The screens use the approved carbon-blue shell, copy-paper state colours and ruled custody lines.
Light follows the board. Appearance follows your system until you choose Light or Dark.
Archivo is a variable font with weight and width axes. Next.js serves the font from this app.
Its [SIL Open Font License 1.1](apps/web/src/app/fonts/OFL.txt) permits embedding and redistribution.
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

`capture` writes 2x images with the board's frame names. On Windows they are in
`test-results/relay-crm-screens/built/`. Other systems use `relay-crm-screens/built/` under
the system temporary directory. Logs, accessibility results and failure traces stay beside them.
Frames 13 and 15 assemble actual app captures into the board's comparison layout. The payment
content in those frames is outside this screen task. Counts, names, dates and assignment results
come from the seeded API, so they can differ from the illustrative board.
Both commands stop their servers and drop only their own test database when they finish.
