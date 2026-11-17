# Limits

[Back to Relay CRM](../README.md)

This page gathers what v0.1 leaves out and where its guarantees stop. The idea to keep is that the database can check the shape of a change and cannot check who made it. Anyone holding the app's database password can do what the app can do, without the app's rules about who is signed in.

## Outside v0.1

| Not in v0.1             | What there is                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Payment reversal        | No refund, void or correcting entry. A payment in review can only be closed as failed |
| A real payment provider | A sandbox inside the app, which moves no real money                                   |
| An audit viewer         | Audit rows are written, and no screen or operation reads them                         |
| User management         | People, teams and memberships are rows written directly in the database               |
| Other ways to sign in   | An emailed code only                                                                  |
| Tasks                   | A callback on a lead is the only reminder                                             |
| Scheduled lead work     | No job moves, returns or reassigns leads. Round-robin has no quotas or weights        |
| Other email             | Sign-in codes and payment receipts are the only messages the app sends                |
| General export          | Only the campaign funnel exports a CSV file                                           |
| Theming                 | One theme, in light and dark                                                          |

## Native session tokens

A native session token is a bearer secret with a fixed 24-hour life and no refresh. Anyone holding it acts as that person until sign-out or expiry. A demo reset also ends the session.

A browser session and a native session cannot stand in for each other. Browser responses omit session tokens. A browser session's raw database token is not a bearer credential. A native token does not work as a cookie, even with a valid signature. Native sign-out, expiry and demo reset end native sessions. Browser sign-out does not.

Native routes read no ambient credential and set none. Native routes and bearer requests ignore cookies. An invalid bearer never falls back to a valid browser cookie. Other authorization schemes leave browser cookie handling unchanged.

A reverse proxy that injects its own `Authorization: Bearer` header makes browser sessions unauthorized, because the server treats every bearer header as a non-browser request.

A browser cannot attach `Authorization: Bearer` across origins without a preflight that fails, because the server sends no CORS headers. The native routes also refuse `Origin` and `Sec-Fetch-Site`. Bearer requests refuse `Origin`. These header refusals are a second layer. They do not replace the credential rules.

## What the app's database credentials can still do

The app's database role cannot alter a table, disable a trigger, or update or delete history. [Access and security](access-security.md#the-two-database-roles) lists its grants. Inside those grants, direct SQL can still do each of these.

- Change a lead's email address, and so choose where the receipt for a later payment goes. It cannot change the recipient of a receipt that already exists.
- Complete a card payment with a valid posting. The database checks that the posting balances and matches the payment. It cannot check that a provider reported the money.
- Insert approvals in the names of two eligible people and complete a manual payment. The database checks who is named as approver and cannot check who is connected.
- Add a maker to a payment, or attribute an edit to another person. It cannot remove a maker.
- Change the owner or the account of a closed lead, or reopen a lost lead by inserting an intake event. The database guards the status change and cannot check where the intake came from.

Treat the app's database password as you would the right to approve payments. Each item above has a test that performs it with direct SQL as the app role.

```sh
pnpm exec dotenv -- vitest run --project integration packages/store/test/database-role.int.test.ts packages/store/test/payment-safety.int.test.ts packages/store/test/payment-guards.int.test.ts packages/store/test/manual-payments.int.test.ts packages/store/test/work.int.test.ts -t "database credentials|app credentials|maker history"
```

## Payments and receipts

- A manual payment's receipt hash proves nothing about a bank transfer. [Two approvers acting together](payments.md#what-the-receipt-hash-does-and-does-not-prove) can approve an invented receipt.
- While a payment waits for its result, a provider report with a different amount or currency sends it to review whatever status the report carries, including pending, failed and expired. A payment that is already decided does not compare amounts.
- `sent` means the mail server accepted the receipt. It does not mean the message reached an inbox.
- An `unknown` receipt is never retried automatically. A person has to requeue it, and a requeue can produce a second copy of a receipt that had in fact arrived.
- A receipt whose preparation takes longer than the send timeout is marked `unknown` without being sent.
- The lease and the timeout stop two sends of one receipt only if the mail adapter stops when it is aborted. The SMTP adapter in this repository closes its connection. An adapter that ignores the abort signal could still be sending when a requeue starts a second send.
- The sandbox sends its webhook from the app's own process, after it has answered the pay request. A process that exits first loses the webhook, and the reconciler recovers the payment.

## Scale

- The queue reads every open lead of one agent with its history on each request.
- Writers that collide run again, so a burst of writes to one table [resolves close to one at a time](development.md#every-transaction-is-serializable-and-retried).
- The request limits use fixed 60-second windows, so a caller can spend two budgets back to back across a window boundary.

## The demo

The demo's logins are shared and its inbox is open to whoever can reach it. [The demo page](demo.md#what-a-visitor-can-do) lists what a visitor can do as a result. Use invented data only.
