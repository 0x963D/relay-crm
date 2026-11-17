# The API

[Back to Relay CRM](../README.md)

## Read the API

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
It serves these operations under `/api/trpc`.

- `leads.list`, `leads.get` and `leads.edit` read or update contact fields within scope.
- `accounts.list` and `accounts.get` read accounts within scope. The router exposes no account-write operation.
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

The typed API exposes these writes. Each takes a lead `id` and an idempotency `key`.

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

`accounts.list` returns `items` and the scoped `total` before the limit. For an accountant, accounts with ledger postings come first. Within each group it orders by the person's name, then email, then account ID. Other roles use that name order for the whole list. Each item includes the owner, the person's name and email,
and the creating intake's campaign. An accountant can read this identity without access to lead
records. Every caller who can list an account can also read its payment summary. `paymentCount`
counts all payments, and `paymentInProgress` is the state of a pending approval or card checkout,
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

## Payment API

The [payment reference](payments.md) covers card checkouts, manual approval, receipt reads, the event log and the ledger. `payments.get` returns the signed-in person's actions, including `closeReview`. Forms use those decisions instead of deriving access from a role name.

## Assignment guarantees

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
  A typed tRPC API parses inputs and uses SuperJSON for dates.
