# Intake

[Back to Relay CRM](../README.md)

## How intake stays correct under concurrency

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

The public form accepts anonymous submissions, including submissions from other origins.
Set `RELAY_PUBLIC_FORM=0` to turn the form route off with a 404 response. It defaults to on.
Run `pnpm exec dotenv -- vitest run --project integration apps/web/test/web-form.int.test.ts` to check the disabled route.
By design, a new enquiry for a lost lead returns it to the pool and removes its owner.
The intake system actor audits that change. No intake source reopens a dead lead, regardless
of whether its reason is duplicate, wrong number or do not contact.

`pnpm exec dotenv -- vitest run --project integration apps/web/test/web-form.int.test.ts` verifies the form's shared PostgreSQL limits.
Each client may make 10 requests per 60-second fixed window. All clients share a separate
1,000-request window. A refused request returns 429 with `Retry-After: 60` and records no intake.
A client refused by its own budget does not consume the global budget. Invalid submissions count.
The window starts with the first request and resets on the first request after expiry.
The shared counter uses one conditional PostgreSQL upsert. In that same statement, it removes at
most 100 other expired windows, with locked rows skipped. Each window stores its duration, so
cleanup preserves longer windows. `pnpm exec dotenv -- vitest run --project integration packages/store/test/distribution-contract.int.test.ts`
checks the cleanup bound and duration handling. The row lock serializes increments
and refuses increments past the budget. `pnpm exec dotenv -- vitest run --project integration packages/store/test/distribution-contract.int.test.ts`
checks concurrent admission, saturation and expiry.
