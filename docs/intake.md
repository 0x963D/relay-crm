# Intake

[Back to Relay CRM](../README.md)

A lead enters from Meta Lead Ads, the web form or a CSV file. This page covers what each source accepts and how one submission becomes a new lead, an attachment to an existing one, or a recorded refusal. Every source calls the same `store.intake`, which makes one decision per submission from what the database holds, so a person who arrives twice is still one lead.

## One decision per submission

Each source turns its input into an `IntakeSubmission`. It holds the source, the source's own ID for the submission, an email address or null, a name, a phone number, the campaign labels and the raw record. `intakeWith` in `packages/store/src/intake.ts` then runs three steps inside one transaction.

1. It loads a snapshot. The snapshot holds the earlier intake event with this source and external ID, and the lead that holds this email address.
2. It passes the snapshot to `resolveIntake` in `packages/domain/src/intake.ts`. That function is pure. It reads no clock and no database, and it returns exactly one decision.
3. It writes the decision. Every decision except a replay adds one row to `intake_events`. A decision about a lead or an account also adds a timeline entry.

The first rule that matches wins.

| What the snapshot shows                         | What intake does                                  | Recorded outcome                         |
| ----------------------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| The source and external ID were recorded before | Returns the first result and writes nothing       | The first outcome, with `replayed: true` |
| The submission has no usable email address      | Records the submission without a lead             | `rejectedNoEmail`                        |
| No lead holds the email address                 | Creates a lead in the pool                        | `leadCreated`                            |
| The lead is won                                 | Links the submission to the account               | `linkedToAccount`                        |
| The lead is new, assigned or working            | Attaches the submission to the lead               | `attachedToOpenLead`                     |
| The lead is lost                                | Returns the lead to the pool without an owner     | `leadReopened`                           |
| The lead is dead                                | Records the submission and leaves the lead closed | `suppressedDeadLead`                     |

A new enquiry returns a lost lead to the pool, where a manager assigns it again. Reopening records the previous owner, adds a status change to the timeline and writes an audit row under the `intake` system actor. A dead lead never reopens, whether its reason is `duplicate`, `wrongNumber` or `doNotContact`. An attachment leaves the lead's state and owner as they are.

The reopen policy lives in one place. `resolveIntake` asks the lead transition table in `packages/domain/src/lead.ts` whether `reopen` is legal, and that table allows it only from `lost`.

## Email is the identity

`parseEmail` in `packages/domain/src/email.ts` produces the one spelling the `leads_email_key` unique index compares. It trims the address, lowercases ASCII letters and converts the domain to its punycode form. Dots and plus tags in the part before the @ sign stay significant, so `ana.silva@example.com` and `anasilva@example.com` are two leads.

The rule is conservative on purpose. If it splits one person into two leads, an agent closes one as a duplicate. If it merged two people into one lead, nobody could separate their histories again. A character that Unicode folds into an ASCII letter, such as the Kelvin sign for K, makes the address invalid, so it never attaches to the ASCII lead.

Phone numbers are contact data. Intake collapses their whitespace, clips them to 40 characters and never matches on them.

## Two submissions at the same moment

Two requests can load the same snapshot before either writes. Both would then decide to create a lead for the same email. Intake runs inside `transact`, which makes the transaction SERIALIZABLE and runs it again when PostgreSQL reports a conflict. The second run loads a snapshot that contains the first lead and attaches to it. [Development](development.md#every-transaction-is-serializable-and-retried) explains that choice and what it costs.

The test `of twelve intakes for one email leaves one lead and twelve events` in [intake-races.int.test.ts](../packages/store/test/intake-races.int.test.ts) sends the twelve at once with nothing holding them back.

```sh
pnpm exec dotenv -- vitest run --project integration packages/store/test/intake-races.int.test.ts -t "twelve intakes for one email"
```

## Meta Lead Ads

Meta sends a signed notification that names lead IDs and carries no answers. The app fetches each lead from the Graph API, with a 10-second timeout, and passes it to intake with the Meta lead ID as the external ID.

Set `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_ACCESS_TOKEN` and `META_GRAPH_VERSION` in `.env`, and point the Meta webhook at `/api/intake/meta`. With all four unset the route answers 404. With only some of them set the app refuses to start and names the missing ones.

| Request                                                      | Response                                     |
| ------------------------------------------------------------ | -------------------------------------------- |
| `GET` with `hub.mode=subscribe` and the right verify token   | 200 and the `hub.challenge` value            |
| `GET` with anything else                                     | 403                                          |
| `POST` with a valid `X-Hub-Signature-256`                    | 200 once every lead in the batch is recorded |
| `POST` with a missing or wrong signature                     | 401                                          |
| `POST` with a body above 1,000,000 bytes                     | 413                                          |
| `POST` that is signed but cannot be read or fails to process | 500                                          |

The signature is an HMAC-SHA256 of the raw body under the app secret, compared in constant time. A 500 tells Meta to deliver the batch again. The redelivery is safe because the leads already recorded replay by their external ID.

A lead that Graph reports as missing also answers 500. Graph gives the same error for a missing permission, so treating it as final would drop real leads while an access token is misconfigured.

## Web form

`POST /api/intake/form` takes JSON or a URL-encoded form. It accepts anonymous submissions from any origin.

| Field          | Required | Meaning                                                  |
| -------------- | -------- | -------------------------------------------------------- |
| `email`        | Yes      | The person's email address                               |
| `submissionId` | No       | A UUID the form creates when it renders, used as the key |
| `name`         | No       | The person's name, clipped to 200 characters             |
| `phone`        | No       | A phone number, clipped to 40 characters                 |
| `form`         | No       | A label for the form                                     |
| `campaign`     | No       | A label for the campaign                                 |

A submission without a `submissionId` gets a random key, so sending it twice records two events for one lead. A form that sends the same `submissionId` on a retry records one.

| Status | When                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| 202    | The submission is recorded. The body is `{"received":true}`                            |
| 400    | The JSON body cannot be parsed                                                         |
| 404    | `RELAY_PUBLIC_FORM=0` turns the route off. It is on by default                         |
| 413    | The body is above the [body limit](access-security.md#request-body-limits)             |
| 415    | The content type is neither JSON nor a URL-encoded form                                |
| 422    | A field needs fixing. The body names the field and says what to change                 |
| 429    | The caller or the route is over its [request limit](access-security.md#request-limits) |
| 503    | The database could not record the submission. `Retry-After` is 1 second                |

Every recorded submission gets the same 202, whether the email was new, already a lead or already a customer. The answer never tells an anonymous caller which addresses the company knows.

## CSV

`pnpm import:csv leads.csv` reads a file with a header row and an `email` column. The optional columns are `name`, `phone`, `campaign`, `ad_set`, `ad`, `form` and `external_id`. Header names ignore case, and a space or a hyphen reads as an underscore.

A row without an `external_id` gets a key made from a SHA-256 of its own fields. Importing the same file again records nothing new. If you correct one row and import again, only that row is new. Rows run one at a time in file order, and a row that fails does not stop the rows after it.

The command prints a JSON report with the row count, the count of each outcome, the count of replays and each failed row's line number and message. It exits with 0 when every row was recorded, 1 when a row failed, and 2 when the file cannot be read or has no `email` column.

## Tests for this page

Each command runs one file. The integration files use the database in `.env`.

- The decision table, rule by rule: `pnpm exec vitest run --project unit packages/domain/test/intake.test.ts`
- Each outcome written to PostgreSQL, and a dead lead staying closed from every source: `pnpm exec dotenv -- vitest run --project integration packages/store/test/intake.int.test.ts`
- A signed Meta delivery, its redelivery and a tampered body: `pnpm exec dotenv -- vitest run --project integration apps/web/test/meta-webhook.int.test.ts`
- A double submit with and without a submission ID: `pnpm exec dotenv -- vitest run --project integration apps/web/test/web-form.int.test.ts -t "double submit"`
- A second import of the same file, and a corrected row: `pnpm exec dotenv -- vitest run --project integration apps/web/test/csv.int.test.ts`
