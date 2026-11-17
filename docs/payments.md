# Payments

[Back to Relay CRM](../README.md)

## The money invariant

A completed payment credits its account exactly once through a balanced, immutable ledger posting.
Webhook redelivery, reconciliation and the final manual approval use the same settlement function, so concurrent completion cannot credit it again.
It writes the payment, ledger posting, audit and completion outbox row in one transaction.

The real-PostgreSQL test [payments.int.test.ts](../packages/store/test/payments.int.test.ts),
`a webhook, its duplicate and the reconciler collide and credit exactly once`, holds a database
write gate until every caller has reached it. Run it with
`pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts -t "collide and credit exactly once"`.

The manual collision test in [manual-payments.int.test.ts](../packages/store/test/manual-payments.int.test.ts)
forces two approvers to reach the payment write together. Run both proving tests with
`pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts packages/store/test/manual-payments.int.test.ts -t "collide and credit exactly once"`.

A ledger line has a `side` of `debit` or `credit` and a positive amount in minor units.
A posting balances when debits equal credits. Customer accounts are liabilities, so a payment
credits the customer. The card provider and bank are assets, so the payment debits them.
A customer balance is credits minus debits. The database checks both sides against the payment.
Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts`
to check postings and balances.

## Payments and receipts

For the guarantees enforced by PostgreSQL, see [the money invariant](#the-money-invariant).
For the limits of direct database access, see [operational limits](limits.md#operational-limits).

### Card payments

Sandbox payments are off by default. Set `RELAY_SANDBOX=1`, `RELAY_SANDBOX_URL` to the app's HTTP
origin, and distinct `RELAY_PAYMENT_WEBHOOK_SECRET` and `RELAY_RECONCILE_SECRET` values. The sandbox
moves no real money. A production build refuses sandbox startup without `RELAY_DEMO=1`.
With that setting, payment API responses and account ledger responses carry `demo: true` for
screens to show a demo banner. The flag is false otherwise. [Environment tests](#verification)
and [payment HTTP tests](#verification)
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
[payment HTTP tests](#verification) checks
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
Run [payment HTTP tests](#verification)
for expiry, missing checkouts and staff closure.

PostgreSQL checks the payment state shape and transitions. Deferred constraint triggers require a
completed payment to have a posting with balanced lines matching its account, currency and amount,
and exactly one outbox row. Outbox rows cannot be deleted, truncated or moved to another payment.
The unique payment index refuses another posting. Triggers refuse updates, deletes and truncation on ledger
accounts, postings and lines. The worker delivers the receipt after commit.
A replay writes no new state, posting, audit or outbox row; delivery/check history remains observable.

Run `pnpm reconcile` using the repository environment. A scheduler can instead send
`POST /api/payments/reconcile` with `Authorization: Bearer <RELAY_RECONCILE_SECRET>`.
The reconcile HTTP route returns only `checked` and `changed` counts. The outbox HTTP route returns
only `processed`, `sent`, `failed`, `suppressed`, `unknown`, `superseded` and `recordingFailed` counts. Neither returns record IDs.
[payment HTTP tests](#verification) verifies that.
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

[environment tests](#verification) verifies the timing defaults. `RELAY_RECONCILE_FIRST_MS`
defaults to 900000 and `RELAY_RECONCILE_INTERVAL_MS` to 300000. `RELAY_SANDBOX_LATE_MS` defaults to 30000. For a local interview run, set the first delay to zero and the late delay long enough to
call the reconciler before delivery. Signature, timestamp tolerance and replay behavior run in
[payment HTTP tests](#verification).

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

`accounts.ledger` returns each entry's `completion` with `by` and `at`. A manual completion also
includes the second approver's name in `approver`, read from the final ordered approval event. System
completions identify `reconciler` or `providerWebhook`. The reader batches payments, approval events,
people and postings without a query per payment. Agents still receive no ledger or balance.
Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/payment-reads.int.test.ts`
for detail fields, scoped group totals, completion provenance and query counts with one payment and several payments.

## Sandbox navigation and delivery

`RELAY_SANDBOX_DELIVERY_URL` sets the origin the serving process uses to deliver webhooks. It defaults to `RELAY_SANDBOX_URL`. Compose sets it to the app's internal address, so changing the published port does not break delivery. The public pay link still uses `RELAY_SANDBOX_URL`.

The creation panel shows the pay link once. Opening it creates a new tab with no opener or referrer. Every sandbox response sends `Referrer-Policy: no-referrer`. Returning to the app replaces the sandbox history entry. Reloading or opening the payment elsewhere does not recover the token.

Payment records show the sold-by agent and the signed-in person's available actions. Review panels compare money only for a money mismatch. Paid-after-close panels compare the states and say when the amount and currency match. The event log runs oldest first and groups consecutive unchanged checks.

`payments.receiptUse` finds the payment using a receipt hash within the caller's read scope. The duplicate-receipt refusal links it when that read succeeds.

## Verification

Run the payment HTTP tests for sandbox startup, response flags, checkout privacy, expiry, staff closure, webhook signatures and job responses.

```sh
pnpm exec dotenv -- vitest run --project integration apps/web/test/payments.int.test.ts
```

Run the environment tests for startup requirements and timing defaults.

```sh
pnpm exec vitest run --project unit apps/web/test/env.test.ts
```
