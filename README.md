# Relay CRM

Relay CRM is a sales CRM for a small team that buys leads from ads and closes them by phone.
It is a local build. Nothing has been published. The name is a working title.

## Status

Lead intake, email code sign-in, scoped access and lead assignment work through the API.
The only screen is the existing lead list. The work queue, payments and their screens are not built.

What works today:

- Intake from Meta Lead Ads, a web form and CSV uses one race-safe, idempotent operation.
  It creates, attaches, reopens or links a submission without creating duplicate leads.
- Existing staff sign in with an expiring email code. There is no sign-up. Unknown addresses
  receive the same response, get no mail and cannot obtain a session. Codes have limited guesses,
  and PostgreSQL stores request limits across application processes.
- A session selects one current team. The server loads the current role and membership.
  One domain function decides lead and account scope. Agents read and edit their own records.
  Sales team leads read their team's leads and the pool, assign within that team, and edit only
  their own records. Managers, admins and owners see and edit everything. Accountants read every
  account and no leads, and cannot edit or assign.
- Team leads and management manually assign pool leads, individually or in a batch.
  Round-robin has an immutable preview and a fingerprint. Changed leads invalidate the preview,
  even if a lead returns to its earlier state. An idempotency key replays the first result.
  The planner can exclude previous owners. Reassignment preserves status and follow-up detail.
- Every assignment commits ownership, an activity and an append-only audit row together.
  Writes reload permissions and scope within the same serializable transaction.
- A typed tRPC API parses inputs and uses superjson for dates.

`pnpm test` reports 506 passing unit tests. `pnpm test:int` reports 97 passing integration tests
against real PostgreSQL, including forced assignment races that check the persisted rows.
`pnpm test:prod` reports 5 passing production tests. It checks unauthenticated behavior, the
development grant, SMTP sign-in and scoped API errors after visiting the lead page.

The form intake endpoint still has no rate limit. This build is not ready for public hosting.

## How it is built

The workspace has three packages, and each one holds one kind of knowledge.

| Package           | What it knows                                                 | What it must not do                 |
| ----------------- | ------------------------------------------------------------- | ----------------------------------- |
| `packages/domain` | The rules: lead states, access scopes, email identity, intake | Import a dependency, read the clock |
| `packages/store`  | Every SQL statement and every transaction                     | Export the Prisma client            |
| `apps/web`        | HTTP: the intake sources, their routes and the lead list      | Depend on a database client         |

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

You need Node.js 24, pnpm 11 and a PostgreSQL 17 server.

1. Install the dependencies and generate the Prisma client.

   ```sh
   pnpm install
   pnpm db:generate
   ```

2. Copy `.env.example` to `.env` and set `DATABASE_URL`. Use a dedicated database:

   ```sh
   docker run --name relay-crm-pg -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay \
     -e POSTGRES_DB=relay -p 127.0.0.1:54329:5432 -d postgres:17
   ```

3. Apply migrations and start the app.

   ```sh
   pnpm db:migrate
   pnpm dev
   ```

   The lead list is at <http://localhost:3000>. Without a session it shows the not-signed-in page.
   To use the existing development grant, set `RELAY_DEV_ACTOR=1`. Its role defaults to agent.
   Set `RELAY_DEV_ROLE=owner` to see the pool. The grant works only under `pnpm dev`.

4. Send a lead through the web form endpoint.

   ```sh
   curl -X POST http://localhost:3000/api/intake/form \
     -H 'content-type: application/json' \
     -d '{"email":"ana@example.com","name":"Ana Silva","campaign":"spring"}'
   ```

   The response is `{"received":true}` with status 202. With `RELAY_DEV_ROLE=owner` the lead
   appears in the list.

## Commands

| Command                  | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| `pnpm dev`               | Starts the app in development mode                              |
| `pnpm build`             | Builds the app. It needs no database                            |
| `pnpm start`             | Serves the built app                                            |
| `pnpm db:generate`       | Generates the Prisma client from the schema                     |
| `pnpm db:migrate`        | Applies the migrations to `DATABASE_URL`                        |
| `pnpm import:csv <file>` | Imports a CSV file through intake and prints a report           |
| `pnpm test`              | Runs the unit tests. They need no database                      |
| `pnpm test:int`          | Runs the integration tests against the server in `DATABASE_URL` |
| `pnpm test:prod`         | Builds and tests the production server against PostgreSQL       |
| `pnpm lint`              | Runs ESLint with type-aware rules                               |
| `pnpm format:check`      | Checks formatting with Prettier                                 |
| `pnpm typecheck`         | Typechecks every package and its tests                          |

The integration tests create a template database and one database per test, and drop each test's
database when the test ends. The database user needs the `CREATEDB` privilege.

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
Mail delivery runs after the response and has no durable retry until an outbox is built.

The tRPC router is exported as `AppRouter` from `apps/web/src/server/rpc.ts`.
It serves these operations under `/api/trpc`:

- `leads.list`, `leads.get` and `leads.edit` read or update contact fields within scope.
- `accounts.list` and `accounts.get` read accounts within scope. Account writes are not exposed yet.
- `leads.assign` assigns pool lead IDs to an agent's sales team. `leads.reassign` keeps the lead's status.
- `distribution.preview` takes lead IDs, chosen agents and `excludePreviousOwner`.
- `distribution.submit` takes `previewId`, `fingerprint` and an idempotency `key`.
  Keys belong to the authenticated user. A replay uses the first result, even if its new input differs.
  Current scope must still permit access to that result.
- `session.selectTeam` selects a current membership for the session, or clears it.

Out-of-scope records return access denied. A changed preview returns a typed conflict.
The API error includes `data.accessFailure` for these domain refusals.

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

The agreed v0.1 has three journeys:

1. A lead arrives, a manager or team lead assigns it from the pool, and it lands in an agent's queue.
   Intake, sign-in, scope and assignment work now. The queue and assignment screens are not built.
2. The agent works the lead to won or lost. The domain state machine exists. The work API and screens
   are not built.
3. A payment is recorded, two different people approve it, and a conflicting payment is refused.
   Payment storage, operations and screens are not built.

Not built and cut from v0.1:

- The outbox and email connector beyond sign-in code delivery.
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
