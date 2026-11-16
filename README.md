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
- A session starts in its sole team when the user has exactly one membership. With several
  memberships, `session.current` returns the choices. Team-scoped operations require a selection
  and return `teamSelectionRequired` until the user chooses. The server reloads current roles
  and memberships inside each human record operation's transaction.
- `recordScope` in `packages/domain/src/access.ts` decides all record and target-agent scope.
  `scopeAdmits` applies that scope to a record. `scopeWhere` in `packages/store/src/scope.ts`
  only translates it into a SQL filter. Lists and individual operations use those same decisions.
  Agents read and edit their own records. Sales team leads read their team's leads and the pool,
  assign within that team, and edit owned records that their read scope also admits.
  Managers, admins and owners see and edit everything. Accountants read every account and no leads,
  and cannot edit or assign. Edit and assignment scopes always stay within read scope.
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
including forced races, forward migration of populated tables and catalog checks for unique indexes.
`pnpm test:prod` checks the production build, SMTP sign-in and scoped API errors.
`pnpm test:mutations <output-directory>` removes each covered safety check in turn, requires its
named test to fail, restores the source in `finally`, and reruns the unchanged tests.

The public form accepts anonymous submissions, including submissions from other origins.
By design, a new enquiry for a lost lead returns it to the pool and removes its owner.
The intake system actor audits that change. No intake source reopens a dead lead, regardless
of whether its reason is duplicate, wrong number or do not contact.

`pnpm test:int -- apps/web/test/web-form.int.test.ts` verifies the form's shared PostgreSQL limits.
Each client may make 10 requests per 60-second fixed window. All clients share a separate
1,000-request window. A refused request returns 429 with `Retry-After: 60` and records no intake.
A client refused by its own budget does not consume the global budget. Invalid submissions count.
The window starts with the first request and resets on the first request after expiry.
The shared counter uses one conditional PostgreSQL upsert. The row lock serializes increments
and refuses increments past the budget. `pnpm test:int -- packages/store/test/distribution-contract.int.test.ts`
checks concurrent admission, saturation and expiry.

`RELAY_TRUSTED_PROXY_COUNT` defaults to 0. `pnpm test -- apps/web/test/client-address.test.ts`
checks that 0 ignores all forwarded headers and uses the TCP peer. A positive setting selects
that many hops from the right of `X-Forwarded-For`. An invalid address or a shorter chain falls
back to the TCP peer. Configure the exact proxy count and prevent direct access around those
proxies. Each proxy must append the peer address or overwrite the header with a verified chain.
IPv4-mapped IPv6 and IPv6 spellings are canonicalized before counting.

Use `pnpm dev` and `pnpm start`. Their Node HTTP entry point captures the connection address
in request-local storage before Next handles the request. Running `next start` directly lacks
that context and puts requests without a trusted forwarded address in one `unknown` budget.
`pnpm test -- apps/web/test/env.test.ts` checks that the proxy count is an integer from 0 to 32.

## How it is built

`pnpm -r list --depth -1` lists the workspace packages. Each one holds one kind of knowledge.

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

Use the Node.js and pnpm versions declared in `package.json`, and a dedicated PostgreSQL server.

1. Install the dependencies and generate the Prisma client.

   ```sh
   pnpm install
   pnpm db:generate
   ```

2. Copy `.env.example` to `.env` and set `DATABASE_URL`. Clear the placeholder `AUTH_SECRET`
   to keep sign-in off, or replace it with a generated secret before enabling sign-in. Use a dedicated database:

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
   Set `RELAY_DEV_ROLE=owner` to see the pool. The grant works only in development-server bundles.
   The build fixes that fact using Next's configuration phase and an inlined flag.
   Production startup refuses a nonempty `RELAY_DEV_ACTOR`, even with `NODE_ENV=development`.
   `pnpm test:prod` reproduces that startup and checks that no development user is created.

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
contact-field edits and assignment to every system actor. The payment jobs have no record permissions yet.
The database requires an audit actor to be either a user or a named system actor, never both or neither.

Audit actions are currently `leadAssigned` and `leadReopened`. Subjects are typed as leads or accounts.
The database enforces these closed sets and object snapshots, and refuses audit updates and deletes.
Each manual assignment operation generates a request ID, shared by all changed leads in its batch.
Reopening uses its intake event ID. A distribution submission uses its idempotency receipt ID for
both `request_id` and the foreign key `idempotency_id`. That foreign key checks at commit so the audit
can precede its immutable receipt inside the same transaction.

Forward migrations preserve stored receipts and decode old lifecycle snapshot strings into objects.
Old audit rows use their own audit ID as a correlation ID because their original request was not stored.
Receipts created before request hashing have no recoverable hash and refuse key reuse. New receipts
always store a hash. These limits apply to historical data, not to newly recorded operations.

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
   Intake, sign-in, scope and assignment work now. The queue and assignment screens are not built.
2. The agent works the lead to won or lost. The domain state machine exists. The work API and screens
   are not built.
3. A payment credits its account exactly once through a balanced ledger posting. Card webhooks and
   reconciliation share settlement with the final manual approval. Notifications use an outbox.
   Payments, the ledger, reconciliation and the outbox are not built.

Other work not built:

- The email connector beyond sign-in code delivery.
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
logs the original error with that ID. The tRPC formatter preserves typed domain failures in
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

`pnpm test -- apps/web/test/env.test.ts` verifies that `AUTH_SECRET` needs at least
32 characters and 12 distinct characters, and refuses the exact placeholder in `.env.example`.
These checks reject obvious weak values. They do not measure entropy. Use the generator rather
than a phrase that happens to pass the checks. `pnpm test:prod` verifies startup refusal for a
repeated-letter secret and for the placeholder. Empty `AUTH_SECRET` leaves sign-in off when
`AUTH_URL` and SMTP are also unset.
