# Relay CRM

Relay CRM is a sales CRM for a small team that buys leads from ads and closes them by phone. The
build has nine steps, and steps 1 and 2 are done. Today it takes leads in from Meta Lead Ads, a web
form and CSV files, decides what each submission means, and shows the leads in a list.

The name is a working title.

## Status

Steps 1 and 2 are done. Work on steps 3 to 5 is paused, and none of it is in the code yet. The app
has no sign-in, no lead assignment, no work queue and no payments.

What works today:

- **One intake path.** Every source builds a submission and calls the same function. The function
  creates a lead, attaches the submission to an open lead, reopens a closed lead, links a
  customer's account, or records why it did none of those.
- **Idempotent delivery.** A source's ID for a submission is its idempotency key. Meta can
  redeliver a webhook and a person can double-click a form. Each submission is recorded once.
- **One lead per person.** Two submissions for one email that arrive at the same moment end as one
  lead and two recorded events. The integration tests force that collision and check the rows.
- **One address per person.** An email is stored and sent in one canonical form, with ASCII
  before the @ sign, the domain in punycode and every ASCII letter in lowercase. So
  `Ana@Example.COM` and `ana@example.com` are one lead. An address with a lookalike character,
  such as the Kelvin sign in place of a K, is refused instead of matched to someone else.
- **A lead state machine.** One table holds every status and every event. A new status does not
  compile until each of its transitions is decided.
- **Scoped reads.** One function maps a user to the leads they may read or edit. The lead list
  already goes through it.

There is no sign-in yet, so the lead list answers 401 to everyone. Only `pnpm dev` can act as a
built-in user, and only when `.env` turns it on. The form endpoint has no rate limit. Do not put
this build on the public internet.

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
runs that one again from the start, up to 10 times with a random delay, and the second run sees
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

2. Copy `.env.example` to `.env`, set `DATABASE_URL`, and set `RELAY_DEV_ACTOR=1` to act as the
   built-in dev user. To start a matching database with Docker:

   ```sh
   docker run --name relay-pg -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay \
     -e POSTGRES_DB=relay -p 5432:5432 -d postgres:17
   ```

3. Apply the migrations and start the app.

   ```sh
   pnpm db:migrate
   pnpm dev
   ```

   The lead list is at <http://localhost:3000>. Without `RELAY_DEV_ACTOR=1` it answers 401 with a
   not-signed-in page. With it, `pnpm dev` acts as the dev user with the `agent` role, which sees
   only the leads assigned to it, so the list starts empty. Set `RELAY_DEV_ROLE=owner` to see
   every lead. The dev user exists only when `NODE_ENV` is `development`, which `pnpm dev` sets and
   `pnpm start` does not, so the built app answers 401.

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
| `pnpm test:prod`         | Builds the app, serves it and checks that nobody is signed in   |
| `pnpm lint`              | Runs ESLint with type-aware rules                               |
| `pnpm format:check`      | Checks formatting with Prettier                                 |
| `pnpm typecheck`         | Typechecks every package and its tests                          |

The integration tests create a template database and one database per test, and drop each test's
database when the test ends. The database user needs the `CREATEDB` privilege.

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

Steps 3 to 5 build the backend and a typed API. The screens come after them, in a step of their
own.

3. Sign-in with a one-time code sent by email, or with Google when it is configured. Scoped access
   on every lead and account query. Lead distribution from the pool, where a preview is refused if
   the leads changed hands after it was made.
4. The work queue, with today's follow-ups, overdue callbacks, status changes, notes, and logged
   call and WhatsApp attempts. A daily job returns exhausted leads to the pool.
5. Payments with two-person approval. Two different approvers must approve, and neither of them can
   be the person who recorded the payment. Conflicting payments are refused under concurrency, and
   a reversal runs exactly once.
6. The screens for the work queue, distribution and payments.
7. Reports and the audit viewer.
8. The outbox and email.
9. Whitelabel settings, seed data, Docker and a demo.

## License

MIT. See [LICENSE](LICENSE).
