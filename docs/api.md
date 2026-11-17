# The API

[Back to Relay CRM](../README.md)

Every screen reads and writes through one tRPC router at `/api/trpc`, and a script can call the same operations. This page lists each operation with its input, its result and the ways it refuses. A refusal is a typed code and never a bare error string, so a client can tell a product rule from a failure. An operation that takes a `key` is idempotent, so a retry after a lost response writes nothing twice. [Idempotency keys](#idempotency-keys) gives the rules. The other mutations take no key.

## Read it with curl

With the demo running, these three commands sign in as the manager, read an agent's queue and read one account's ledger. They need curl and Node.js in a POSIX shell. If you changed the app's port, set `RELAY_ORIGIN` to its address first.

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

The second command uses Dele Akinwale's fixed demo ID. The third looks Jonas Weber's account up by name, because account IDs change at every reset.

## How a call works

- A query is a `GET` with one URL-encoded `input` parameter. A mutation is a `POST` with a JSON body.
- Both wrap their input in the SuperJSON envelope `{"json": ...}`. Sending the inner object alone fails input parsing. `--get --data-urlencode` does the URL encoding in the commands above.
- Responses use the same envelope. Dates and money come back as strings in `json`, and `meta` names the fields that are dates or 64-bit integers.
- A `POST` must carry an `Origin` header equal to the origin of `AUTH_URL`, or it gets 403. A request without a session gets 401.
- The response to each call has an `X-Request-ID` header. The audit rows and timeline entries a write creates carry the same ID.
- Inputs are strict. An unknown field, a malformed UUID or an out-of-range number is refused before any operation runs.
- `limit` is 1 to 100 wherever it appears.

The router's type is exported as `AppRouter` from `apps/web/src/server/rpc.ts`. [Access and security](access-security.md) covers sign-in, scope and the limit on body size.

## Refusals

A refused operation returns its code in `error.json.data.accessFailure`, with a message written for the person at the screen.

| Code                        | Status | Meaning                                                         |
| --------------------------- | ------ | --------------------------------------------------------------- |
| `accessDenied`              | 403    | The record is outside the caller's scope, or does not exist     |
| `teamSelectionRequired`     | 400    | The caller belongs to several teams and has not chosen one      |
| `conflict`                  | 409    | The record is not in the state the operation needs              |
| `stalePreview`              | 409    | A lead in the preview changed, or the preview is someone else's |
| `idempotencyConflict`       | 409    | The key was already used for a different request                |
| `invalidAgent`              | 400    | The target is not an agent in a sales team                      |
| `noEligibleAgent`           | 400    | Round-robin excluded every chosen agent for one of the leads    |
| `leadClosed`                | 400    | The lead is won, lost or dead                                   |
| `invalidTransition`         | 400    | The lead has not been worked, so it cannot be won or lost       |
| `callbackInPast`            | 400    | The callback time is not in the future                          |
| `callbackNotSet`            | 400    | There is no callback to clear                                   |
| `wrongNumberNeedsAnAttempt` | 400    | No attempt is recorded in the lead's current assignment         |
| `pendingPayment`            | 409    | The account already has a payment in progress                   |
| `receiptUsed`               | 409    | A live manual payment already uses this receipt hash            |
| `refreshConflict`           | 409    | The payment changed since the caller read it                    |
| `paymentRecorder`           | 400    | The caller recorded this payment and cannot approve it          |
| `paymentMaker`              | 400    | The caller edited this payment and cannot approve it            |
| `alreadyApproved`           | 400    | The caller already approved this payment                        |
| `roleChanged`               | 400    | An approver's role changed since the approval was prepared      |
| `receiptAttemptLimit`       | 409    | The receipt has reached its lifetime attempt limit              |

An unexpected failure has no code. [Error responses](access-security.md#error-responses) says what it returns.

## Idempotency keys

A `key` is 1 to 200 characters and belongs to the signed-in person. The store saves the first result under the key, with a hash of the input.

- The same key with the same operation and input returns the saved result and writes nothing.
- The same key with a different operation or input returns `idempotencyConflict`.
- Another person cannot replay the key, because keys are scoped to their owner.

`payments.createCheckout` is the exception to the first rule. A replay finds the saved payment and then asks the provider again. It marks the payment as being created and returns the checkout with a null `url`. It returns `conflict` while the first call is still creating the checkout, and once the payment is decided.

A replay still needs a valid session. The lead work operations check the caller's current access before they replay. `distribution.submit` returns its saved result even after the caller's role or scope has changed, so a retry reports what the first call did.

## Session

| Operation            | Input                         | Result                                                                   |
| -------------------- | ----------------------------- | ------------------------------------------------------------------------ |
| `session.current`    | None                          | The session, its expiry, the role, every membership and the current team |
| `session.profile`    | None                          | The same role and teams, with the person's name                          |
| `session.selectTeam` | `teamId`, or null to clear it | `{ selected: true }`. A team the caller does not belong to is refused    |

## Leads

| Operation        | Input                                       | Result                                                                               |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `leads.list`     | `limit`                                     | Leads in read scope, newest first, each with its original source and campaign        |
| `leads.get`      | `id`                                        | One lead with its custody, attribution and timeline                                  |
| `leads.pool`     | `limit`, `offset`                           | Unassigned leads the caller may assign, the pool's `total` and `oldestAt`            |
| `leads.agents`   | `offset`                                    | Agents in sales teams within the caller's scope, each with an open-lead count        |
| `leads.queue`    | Optional `agentId`, `limit`, `offset`       | One agent's open leads in [five groups](#the-queue)                                  |
| `leads.edit`     | `id`, `name`, `phone`                       | The lead with its new name and phone. The email is the identity and cannot be edited |
| `leads.assign`   | `leadIds`, `to` with `ownerId` and `teamId` | Assigns pool leads to one agent. A lead that left the pool returns `conflict`        |
| `leads.reassign` | `leadId`, `to`                              | Moves an owned lead and keeps its status, stage and callback                         |

Reassigning a lead to the agent who already holds it returns `changed: false` with no items and writes no history.

`leads.get` returns `custody`, which says where the lead came from, who assigned it last and who holds it now. Its `timeline` runs newest first. An entry for something a person did has the actor's name, the submitted command and the request ID. An intake entry has none of the three. An attempt entry also has its callback time and the count of unanswered attempts up to that point. `contactedAt` is null until someone has spoken to the person.

## The queue

`leads.queue` reads the open leads one agent owns and puts each in exactly one group. The server supplies the current instant and the organisation's time zone from `RELAY_TIME_ZONE`, so every viewer sees the same grouping.

| Group              | Holds                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `overdueCallbacks` | Callbacks before now, including ones from earlier today                  |
| `dueToday`         | Callbacks later on the current local calendar day                        |
| `later`            | Callbacks after the current local calendar day                           |
| `noCallbackSet`    | No callback, and an attempt recorded since the lead's current assignment |
| `notYetCalled`     | No callback, and no attempt since the lead's current assignment          |

The callback groups run soonest first. `notYetCalled` runs by assignment time, newest first. A note is not an attempt, and attempts made before a reassignment do not count for the new owner. `limit` bounds each group, `counts` gives each group's full size, and `nextCallbackAt` is the earliest callback still in the future.

The default target is the caller. Only an agent has a queue. A team lead can open the queue of an agent in their current sales team, and managers, admins and owners can open any agent's. Every row still has to pass the viewer's own read scope.

The partition is the README's last proof, and `work.int.test.ts` repeats it against PostgreSQL in Tokyo and Los Angeles time.

The queue loads every open lead of the agent with its full activity history on each request, groups them in memory and then applies `limit`. Its cost grows with the agent's open leads and their history, not with the page size.

## Working a lead

Four operations record work. Each takes the lead `id` and a `key`, and returns the lead's `id` and an `accountId` that is null unless the lead was won.

| Operation           | Further input                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `leads.logAttempt`  | `channel` of `call` or `whatsApp`, `outcome` of `noAnswer` or `spokeToThem`, a `note`, an optional `callback` |
| `leads.addNote`     | A `note`                                                                                                      |
| `leads.setCallback` | `change`, either `{ "kind": "set", "at": <date> }` or `{ "kind": "clear" }`                                   |
| `leads.close`       | `closing`, one of `won`, `lost` with a `note`, or `dead` with a `reason`                                      |

An agent works their own leads. Anyone else needs edit scope, and a team lead's read access to a teammate's lead does not include it.

The lead's state follows one transition table in `packages/domain/src/lead.ts`.

| State      | Means                                                          | Leaves by                                   |
| ---------- | -------------------------------------------------------------- | ------------------------------------------- |
| `new`      | In the pool with no owner                                      | Assignment, or a dead close                 |
| `assigned` | Owned and not yet worked                                       | An attempt or a callback, or a dead close   |
| `working`  | Owned, with a stage of ready, contacted, callback or no answer | A won, lost or dead close                   |
| `won`      | Closed with an account                                         | Nothing                                     |
| `lost`     | Closed with a written note                                     | A new enquiry, which returns it to the pool |
| `dead`     | Closed as duplicate, wrong number or do not contact            | Nothing                                     |

Five rules decide most refusals.

- Only `spokeToThem` records contact. An unanswered call or message does not.
- Winning and losing need a `working` lead, so at least one attempt or callback comes first.
- A `wrongNumber` close needs an attempt in the current assignment. A `duplicate` or `doNotContact` close does not.
- A callback must be in the future. Setting one over an existing callback moves it.
- A closed lead refuses further work with `leadClosed`.

Winning creates the account in the same transaction, owned by the lead's agent and team. If two people win the same lead at once, the second transaction runs again, finds the lead won and returns the existing account. It creates no second account and no second closing entry.

PostgreSQL enforces the same states without the app. A CHECK constraint admits only the column combinations these states allow and requires a won lead to have an account. A trigger refuses any status change out of `won` or `dead`, and lets a `lost` lead return to `new` only in a transaction that also records the reopening intake event.

## Assignment

Team leads and managers assign pool leads by hand with `leads.assign`, or deal them out with the two distribution operations.

| Operation              | Input                                       | Result                                                                           |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `distribution.preview` | `leadIds`, `agents`, `excludePreviousOwner` | A stored preview with its `id`, `fingerprint` and the planned owner of each lead |
| `distribution.submit`  | `previewId`, `fingerprint`, `key`           | The assignments that were applied                                                |

Round-robin deals one lead at a time, starting with the lead that has waited longest. The agent with the fewest open leads takes the first turn, and equal counts go by ascending user ID. With `excludePreviousOwner`, a lead skips the agent who held it before it returned to the pool.

The preview is the contract. It stores each lead's version, and a submit applies exactly the stored plan or nothing. If any lead changed after the preview, even back to the same state, the submit returns `stalePreview` and assigns none of them. The manager confirms what they saw, and never a plan recomputed after the click.

Every changed assignment commits the new owner, a timeline entry and an audit row in one transaction. A submit's audit rows also reference its idempotency record.

## Accounts and the funnel

| Operation         | Input             | Result                                                        |
| ----------------- | ----------------- | ------------------------------------------------------------- |
| `accounts.list`   | `limit`, `offset` | `items`, the scoped `total` and the `order` used              |
| `accounts.get`    | `id`              | One account in the same shape as a list item                  |
| `accounts.ledger` | `id`              | Each currency's balance and its entries with running balances |
| `reports.funnel`  | None              | `rows`, `campaignCount` and `otherSourceCount`                |

An account item has its owner, the customer's name and email, the campaign that created the lead, `paymentCount` and `paymentInProgress`. Callers who may read the ledger also get `balances` by currency. Agents and team leads get `balances: null`. An accountant's list puts accounts that have postings first, and every list orders by the customer's name, then email. The router has no operation that writes an account. Winning a lead is the only way to open one.

A ledger entry's `completion` says who completed the payment. It is `providerWebhook`, `reconciler` or `manualApproval`, and a manual completion also names the second approver.

`reports.funnel` is for managers, admins and owners. Each row is one original source and campaign, so a web form and an ad with the same campaign name stay apart. A row counts leads received, still unassigned, contacted and won, and gives conversion as won divided by received. A lead counts once, under the intake that created it, however often it was reassigned or reopened. A repeat enquiry adds no lead. `contacted` counts leads with a recorded conversation, not leads with an attempt.

## Payments

[Payments](payments.md) explains what these operations do. This table gives their inputs. [Roles and scope](access-security.md#roles-and-scope) says who is an account editor and who is an approver.

| Operation                 | Input                                                                                 | Who may call it                                     |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `payments.list`           | `limit`, `offset`                                                                     | Anyone, for accounts in their scope                 |
| `payments.get`            | `id`                                                                                  | Anyone who can read the account                     |
| `payments.createCheckout` | `key`, `accountId`, `amount`, `currency`, `kind`, optional `mode`                     | An account editor                                   |
| `payments.closeCheckout`  | `id`, `reason`                                                                        | An account editor                                   |
| `payments.closeReview`    | `id`, `reason`                                                                        | An approver                                         |
| `payments.recordManual`   | `key`, `accountId`, `amount`, `currency`, `kind`, `receiptHash`, optional `reference` | An account editor                                   |
| `payments.editManual`     | `id`, `version`, `amount`, `currency`, `receiptHash`, `reference`                     | An account editor                                   |
| `payments.approve`        | `id`, `version`, `roleVersion`                                                        | An approver who is not a maker                      |
| `payments.reject`         | `id`, `version`, `reason`                                                             | The same people as approve                          |
| `payments.cancel`         | `id`, `version`, `reason`                                                             | The recorder                                        |
| `payments.requeueReceipt` | `id`                                                                                  | An approver                                         |
| `payments.receiptUse`     | `hash`                                                                                | Anyone. Returns the payment only within their scope |

`amount` is a string of digits in minor units, so `"39500"` in `GBP` is £395.00. `currency` is one of `AED`, `EUR`, `GBP`, `JPY`, `KWD` and `USD`. `kind` is `first` or `repeat`.

`payments.list` returns four groups: `waitingForApproval`, `waitingForProvider`, `needsReview` and `decidedThisWeek`. The last holds payments decided since Monday 00:00 in `RELAY_TIME_ZONE`, which defaults to UTC. `limit` bounds each group and `counts` gives each group's full size.

`payments.get` returns the state, the customer, the agent credited with the sale, the provider's checkout ID, the receipt with its attempts, the approval history and an event log in database order. It also returns `actions`, which says what the signed-in person may do to this payment and, when they may not approve, why. Screens show or hide controls from `actions` and never from the role name. The posting is included only for callers who may read the ledger.

## Tests for this page

- Input parsing, typed refusals and request IDs over HTTP: `pnpm exec dotenv -- vitest run --project integration apps/web/test/rpc.int.test.ts`
- Queues, lead work, wins under contention, the funnel and account lists: `pnpm exec dotenv -- vitest run --project integration packages/store/test/work.int.test.ts`
- Assignment races, stale previews, replays and scope: `pnpm exec dotenv -- vitest run --project integration packages/store/test/access-assignment.int.test.ts packages/store/test/distribution-contract.int.test.ts`
- The lead transition table, cell by cell: `pnpm exec vitest run --project unit packages/domain/test/lead.test.ts`
