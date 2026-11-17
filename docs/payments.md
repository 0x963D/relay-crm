# Payments

[Back to Relay CRM](../README.md)

This page covers how a card payment and a manual payment reach the ledger, and how a receipt is sent afterwards. The idea to keep is that every completion, whatever triggers it, runs one function inside one transaction. A duplicate webhook, a late webhook, the reconciler and a second approver can all arrive together, and the account is still credited once.

## The money invariant

A completed payment has exactly one ledger posting, and the posting credits the customer's account with the payment's amount. Three things can complete a payment: a provider webhook, the reconciler and the second approval of a manual payment. All three call `settlePayment` in `packages/store/src/payments.ts`.

`settlePayment` runs these steps in the caller's transaction.

1. It reads the payment row again and asks the transition table in `packages/domain/src/payment.ts` for the next state.
2. If the state does not change, it stops. A replay writes no state, no posting, no audit row and no receipt.
3. For a completion it inserts the posting, updates the payment, writes the audit rows, inserts the two ledger lines, queues the receipt in the outbox and appends a settlement event. Any other state change updates the payment and writes one audit row.

The transaction commits all of that or none of it. Two callers that complete the same payment at once cannot both commit, because [every transaction is SERIALIZABLE](development.md#every-transaction-is-serializable-and-retried) and `ledger_transactions` has a unique index on the payment. The store runs the loser again. On its second run the loser reads a completed payment and stops at step 2.

PostgreSQL enforces the same rule without the app. Constraint triggers that run at commit refuse a completed payment unless it has one posting, two lines that balance and match the payment's account, currency and amount, and one outbox row. A trigger on `payments` refuses every state change the transition table does not allow.

The test `a webhook, its duplicate and the reconciler collide and credit exactly once` in [payments.int.test.ts](../packages/store/test/payments.int.test.ts) holds every caller at a database gate until all of them have arrived, then releases them together.

```sh
pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts -t "collide and credit exactly once"
```

## The ledger

The ledger is double-entry and append-only. A posting is one row in `ledger_transactions` and two rows in `ledger_lines`. Each line has a `side` of `debit` or `credit` and a positive amount in minor units, stored as a 64-bit integer. Amounts are never floats and never rounded.

A customer's account is a liability, because the company owes the customer what they paid for. A payment therefore credits the customer. The other line debits an asset account. That account is `Card provider, sandbox` for a card payment and `Bank transfers and cash` for a manual one. A customer's balance is their credits minus their debits. Nothing stores a balance. Every read adds up the lines, per currency.

The app's database role cannot update or delete a ledger row, and triggers refuse the same for the table owner. [Access and security](access-security.md#the-two-database-roles) lists those grants.

An approver reads postings and balances through `accounts.ledger`. [Roles and scope](access-security.md#roles-and-scope) says who is an approver and who may edit an account. An agent can read their own payments, without the posting, and cannot call `accounts.ledger`.

v0.1 has no reversal, so a posting made in error cannot be corrected inside the app.

## Payment states

| State             | Method | Meaning                                                                  | Next states                                     |
| ----------------- | ------ | ------------------------------------------------------------------------ | ----------------------------------------------- |
| `checkoutCreated` | Card   | The checkout exists and the provider has not reported a result           | `completed`, `needsReview`, `failed`, `expired` |
| `pendingApproval` | Manual | Recorded and waiting for two approvals                                   | `completed`, `rejected`, `cancelled`            |
| `completed`       | Both   | Credited, with one posting                                               | None                                            |
| `needsReview`     | Card   | The provider reported money the app will not credit by itself            | `failed`                                        |
| `failed`          | Card   | The provider failed it or never had it, or staff closed it with a reason | `needsReview`                                   |
| `expired`         | Card   | The checkout passed its lifetime unpaid                                  | `needsReview`                                   |
| `rejected`        | Manual | An approver refused it with a reason                                     | None                                            |
| `cancelled`       | Manual | Its recorder withdrew it with a reason                                   | None                                            |

One account has at most one payment in `checkoutCreated` or `pendingApproval`. A partial unique index enforces it, and a second attempt returns `pendingPayment`.

## Card payments

The payment provider is a sandbox inside the app. It moves no real money. It has its own table, its own checkout IDs and its own page, and the CRM talks to it only through the `PaymentProvider` interface, a signed webhook and a status read.

### From checkout to credit

1. A person who can edit the account calls `payments.createCheckout`. The store inserts the payment in `checkoutCreated` and the provider creates a checkout with its own ID.
2. The response carries a pay link. The link contains a random 32-byte token, and the database stores only its SHA-256 hash. No later read or replay returns the link, so a person who can read the payment cannot pay it.
3. The customer pays on the provider's page.
4. The provider posts a signed webhook to `/api/payments/webhook`. The app calls `settlePayment` with the money the provider reported.
5. If no webhook arrives, the reconciler asks the provider for the checkout's status and calls `settlePayment` with the answer.

Step 5 is why a lost webhook delays a payment and does not lose it. The webhook is the fast path and the reconciler is the guarantee. A webhook that arrives after the reconciler has completed the payment is recorded in the event log and changes no money.

If the response in step 2 is lost after the provider created the checkout, the link is gone. Close the waiting payment and create another.

### What the provider can report

For a payment that is still waiting for its result, `settlePayment` compares the reported amount and currency with the payment before it looks at the status. Once a payment is decided, only the last row applies: a completed payment ignores every later report, and a failed or expired one reacts only to a report that it was paid.

| Provider report                                | Result                                                |
| ---------------------------------------------- | ----------------------------------------------------- |
| Paid, with the expected money                  | `completed`, with one posting                         |
| Any status with a different amount or currency | `needsReview`, with no posting                        |
| Still pending                                  | No change                                             |
| Failed or expired                              | `failed` or `expired`                                 |
| No such checkout                               | `failed`, because creation never reached the provider |
| Paid, after the payment was closed or expired  | `needsReview` with the reason `paid after close`      |

Review never credits, and no transition leads from review to `completed`. The audit row keeps the reported money and the reason. An approver closes the review as `failed` with a written reason through `payments.closeReview`. The app does not decide what a mismatch means. It stops and leaves the decision to a person.

### Closing a checkout

`payments.closeCheckout` lets an account editor close a waiting checkout as `failed` with a written reason. The app then cancels the checkout at the provider and reads its status. If the customer had already paid, the same request moves the payment to `needsReview` and says so. With sandbox payments turned off, the app records that it did not ask the provider.

A checkout expires after `RELAY_CHECKOUT_TTL_MS`. The reconciler keeps checking a closed or expired card payment until the provider gives a final answer, so a late payment still reaches review.

### The webhook

The provider signs each webhook with HMAC-SHA256 over the timestamp, a full stop and the raw body, under `RELAY_PAYMENT_WEBHOOK_SECRET`. The app refuses a wrong signature or a timestamp more than five minutes from its own clock with 401.

Each webhook carries an event ID. The app stores the ID with a hash of the body in `webhook_inbox`. A redelivery of the same event settles nothing and adds an event marked as a duplicate. The same ID with a different body gets 409. Every accepted delivery, including duplicates and late arrivals, appears in the payment's event log with the money it reported and whether the state changed.

The sandbox sends the webhook from the serving process after it has answered the pay request. If that process stops first, the webhook is lost and the reconciler recovers the payment.

### The reconciler

The reconciler runs from `pnpm reconcile` or from `POST /api/payments/reconcile` with `Authorization: Bearer <RELAY_RECONCILE_SECRET>`. The route answers with `checked` and `changed` counts and no record IDs. The command needs the sandbox settings below. It needs `RELAY_DEMO=1` only when `NODE_ENV=production`.

It scans for card payments whose next check is due, then handles each in three steps.

1. In one transaction it claims the payment with a conditional update that stores a claim token and moves the next check forward by the interval. A second reconciler that loses the claim skips the payment and never calls the provider.
2. It asks the provider, outside any transaction.
3. In a second transaction it checks that its token is still the current one, then calls `settlePayment`. A superseded check records the provider's answer and settles nothing.

A reconciler that stops between steps leaves nothing locked. The payment becomes due again at its next check time. A provider read that fails records an unsuccessful check and leaves the payment for the next run.

A new payment is not checked while its checkout is still being created. Creation holds a token with a 30-second deadline, and the reconciler waits for the creation to finish or the deadline to pass. Without that wait, a reconciler with no first-check delay could ask the provider before the checkout exists and fail a good payment.

| Setting                       | Default  | Meaning                                                 |
| ----------------------------- | -------- | ------------------------------------------------------- |
| `RELAY_RECONCILE_FIRST_MS`    | 900000   | Delay before a new payment's first check                |
| `RELAY_RECONCILE_INTERVAL_MS` | 300000   | Delay between later checks of the same payment          |
| `RELAY_CHECKOUT_TTL_MS`       | 86400000 | Lifetime of an unpaid checkout                          |
| `RELAY_SANDBOX_LATE_MS`       | 30000    | How long the sandbox holds a webhook in its `late` mode |

Payment reads return the first-check delay and the interval, so a screen can say when the next check is due.

### Turning the sandbox on

Sandbox payments are off by default. Set `RELAY_SANDBOX=1`, `RELAY_SANDBOX_URL` to the app's public HTTP origin, and `RELAY_PAYMENT_WEBHOOK_SECRET` and `RELAY_RECONCILE_SECRET` to two different [generated secrets](access-security.md#secrets). `RELAY_SANDBOX_DELIVERY_URL` sets the origin the app uses to deliver webhooks to itself. It defaults to `RELAY_SANDBOX_URL`.

A production build refuses to start with the sandbox on unless `RELAY_DEMO=1` is also set. With `RELAY_DEMO=1`, payment and ledger responses carry `demo: true`, and the provider's page shows five choices for what happens to the webhook.

| Mode              | What the sandbox does after payment                    |
| ----------------- | ------------------------------------------------------ |
| `normal`          | Sends the webhook once                                 |
| `drop`            | Sends nothing, so the reconciler completes the payment |
| `twice`           | Sends the same webhook two times                       |
| `late`            | Waits `RELAY_SANDBOX_LATE_MS`, then sends the webhook  |
| `differentAmount` | Reports one minor unit more than the payment's amount  |

The provider's page opens in a new tab with no opener, and every response from it sends `Referrer-Policy: no-referrer`, so the token in its address does not leak to another site.

## Manual payments

A manual payment records money that arrived outside the app, by bank transfer or in cash. The app cannot see the bank account, so the control is two people who did not set the terms.

### From record to credit

1. A person who can edit the account calls `payments.recordManual` with the amount, a `receiptHash` and an optional `reference`. The payment starts in `pendingApproval`.
2. An approver calls `payments.approve`. The store adds one approval.
3. A second, different person approves. Inside that same transaction the store counts two valid approvals and calls `settlePayment`, which debits `Bank transfers and cash` and credits the customer.

Nothing is posted before the second approval.

### Who may approve

A maker is anyone who recorded the payment or edited its terms. A maker can never approve that payment. The set of makers only grows. A trigger adds the recorder when the payment is created and each editor when they edit, and the table refuses updates and deletes.

Editing changes what is being approved, so `payments.editManual` raises the payment's version and voids every approval already given. An approver must send the version they are looking at. If the terms changed underneath them, the request fails with `refreshConflict` and they read the payment again.

A role change voids approvals too. Each person has a role version that rises when their role changes. An approval stores the approver's role version, and a trigger voids that person's approvals on waiting payments when the version rises. The second approval also reloads the first approver's role, so a person demoted between the two approvals does not count.

The database checks the same rules by itself. A trigger on `payment_approvals` refuses an approval from a maker, from a person whose role is not an approver's, or with a stale version. A constraint trigger at commit refuses to complete a manual payment without two current approvals from people who are not makers.

`payments.reject` and `payments.cancel` end a waiting payment with a written reason and credit nothing. Only an approver who is not a maker may reject. Only the recorder may cancel. Both release the account for a new payment.

### What the receipt hash does and does not prove

`receiptHash` is 64 lowercase hexadecimal characters that the caller supplies. A unique index allows one live manual payment per hash, so the same receipt cannot be entered twice by mistake. A rejected or cancelled payment releases its hash.

The app stores no receipt file. It does not check that a file exists or that a transfer happened. Two approvers acting together can approve an invented receipt. A person who can record payments and already holds a hash can also learn whether a live payment uses it, because the `receiptUsed` refusal has to say why it refused.

The test `the last editor is a maker and editing voids existing approvals` in [manual-payments.int.test.ts](../packages/store/test/manual-payments.int.test.ts) covers the edit rule, and `two different approvals collide and credit exactly once` forces two approvers to reach the payment together.

```sh
pnpm exec dotenv -- vitest run --project integration packages/store/test/manual-payments.int.test.ts -t "editing voids existing approvals"
```

## Receipts

Settlement queues a receipt and does not send it. The outbox row commits with the posting, and a separate worker sends the email afterwards. A mail server that is down therefore cannot block or undo a payment, and a receipt never goes out for a payment that rolled back. A demo reset is the one exception. It rebuilds the invented data inside a single transaction and sends the seeded receipts before that transaction commits.

### The worker

The worker runs from `pnpm outbox` or from `POST /api/payments/outbox` with `Authorization: Bearer <RELAY_OUTBOX_SECRET>`. Both need `SMTP_URL` and `SMTP_FROM`, and neither needs sign-in to be configured. The route answers with counts and no record IDs.

For each due receipt the worker runs four steps.

1. It leases the row with `FOR UPDATE SKIP LOCKED` and stores a lease token and an expiry taken from the database clock. A second worker skips a leased row.
2. In a second transaction it records a numbered attempt in the state `unknown`.
3. It sends the email outside any transaction, and aborts the send at `RELAY_RECEIPT_SEND_TIMEOUT_MS`.
4. It records the outcome and clears the lease.

If step 4 fails for one receipt, the worker leaves that attempt `unknown`, tries to append a `receiptRecordingFailed` event to the payment and carries on with the rest of the batch. If the database refuses that event too, the failure appears only in the worker's result, as `failureRecorded: false`.

Step 2 comes before the send on purpose. If the worker dies during the send, the row already says `unknown`, and the worker never retries an `unknown` receipt by itself. The choice is between a customer who might get no receipt and one who might get two, and the app picks the first because a person can requeue it.

| State        | Meaning                                                                     | What happens next                                      |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `sent`       | The mail server accepted the message                                        | Nothing. Acceptance does not prove it reached an inbox |
| `suppressed` | The address is on the suppression list, or the account has no address       | Nothing is sent                                        |
| `failed`     | The send failed before any message data left, or the server clearly refused | Retries after 5, 10 and 20 minutes                     |
| `unknown`    | Message data left and no clear answer came back, or the worker stopped      | Waits for a person to requeue it                       |

A failed receipt gets four attempts in a cycle. `payments.requeueReceipt` lets an approver start a new cycle for a `failed` or `unknown` receipt, and every requeue writes an audit row. `RELAY_RECEIPT_LIFETIME_ATTEMPTS`, 12 by default, caps attempts across all cycles. At the cap a requeue returns `receiptAttemptLimit`.

Every attempt for one receipt uses the same Message-ID, so a mail server that deduplicates can drop a second copy. SMTP itself does not promise that.

### Leases and timeouts

`RELAY_RECEIPT_LEASE_MS` defaults to 60000 and `RELAY_RECEIPT_SEND_TIMEOUT_MS` to 30000. The server refuses to start unless the timeout is shorter than the lease. A send that has not finished by the timeout is aborted while the worker still holds the lease, so a second worker cannot start the same receipt while the first is still sending. The timeout clock starts before the lease is taken, so slow preparation counts against it.

The app's database role can change a receipt's state, lease and retry time. It cannot change the recipient, move the receipt to another payment or set the attempt count. The count rises only when a trigger sees the next numbered attempt inserted.

## One run at a time

The two job routes take a lease before they work, so two scheduled calls to the same route do not overlap. The lease is one row per route in `job_leases`, with a token and an expiry set from the database clock. Reconciliation leases for 15 seconds and the outbox for 60, and a running job renews its lease every third of that. A second call while the lease is live gets 429. A caller that stops without releasing loses the lease when it expires, and a job that fails to renew is aborted.

The lease only spaces out scheduled calls. Correctness does not depend on it. `pnpm reconcile` and `pnpm outbox` take no route lease, and the per-payment claim and the per-receipt lease still stop two workers from handling the same row.

[Access and security](access-security.md#request-limits) covers the limit on wrong secrets for both routes.

## Tests for this page

- Settlement races, lost and late webhooks, and what the database refuses: `pnpm exec dotenv -- vitest run --project integration packages/store/test/payments.int.test.ts`
- Approvals, makers, role versions, edits and receipt collisions: `pnpm exec dotenv -- vitest run --project integration packages/store/test/manual-payments.int.test.ts packages/store/test/payment-guards.int.test.ts`
- Retry timing, the lifetime cap, worker collisions and requeue: `pnpm exec dotenv -- vitest run --project integration packages/store/test/outbox.int.test.ts`
- Job leases, expiry and renewal: `pnpm exec dotenv -- vitest run --project integration packages/store/test/jobs.int.test.ts apps/web/test/job-routes.int.test.ts`
- Webhook signatures, the pay link, expiry, staff closure and job responses over HTTP: `pnpm exec dotenv -- vitest run --project integration apps/web/test/payments.int.test.ts`
- SMTP acceptance, refusal, timeouts and connection loss against local servers: `pnpm exec vitest run --project unit apps/web/test/mailer.test.ts`
