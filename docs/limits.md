# Limits

[Back to Relay CRM](../README.md)

## Outside v0.1

- A general email connector beyond sign-in codes and payment receipts.
- The audit viewer.
- Quota distribution.
- Whitelabel theming.
- General CSV export. The campaign funnel has a CSV export, and CSV intake works.
- Google sign-in.
- The daily pool job.
- Payment reversal.
- Tasks.

## Operational limits

Someone holding the app's database credentials can change a lead's email and aim a future receipt, but cannot change the recipient of an existing receipt. Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/database-role.int.test.ts -t "aim a future receipt"` to check both with direct SQL as the app role.

Someone holding the app's database credentials can complete a card payment directly in SQL with a valid posting, because the database checks the posting's shape and not the provider's evidence.

A delivery adapter that ignores its abort signal can still be sending after its timeout, and a requeue can then start a second send. The shipped SMTP adapter closes its connection on abort.

A receipt whose preparation outlasts the send timeout is marked `unknown` without being sent, and needs a person to requeue it.

A provider report of pending, failed or expired with a different amount also enters review as a mismatch.

Someone holding the app's database credentials can add makers or attribute a SQL edit to another person, but cannot remove existing makers.

Someone holding the app's database credentials can record approvals in two eligible people's names and complete a manual payment, because the database checks who is named as approver and not who is connected.
Someone holding the app's database credentials can change a closed lead's owner or account, or reopen a lost lead by inserting an intake event, because the database guards status changes and not the intake's origin.
Run `pnpm exec dotenv -- vitest run --project integration packages/store/test/payment-guards.int.test.ts packages/store/test/work.int.test.ts -t "database credentials"` to check these limits.

The payment provider is a sandbox inside the app. It moves no real money. Demo logins are shared, so one visitor can use both approver roles. The demo inbox exposes sign-in codes to anyone who can open it. Use invented data only.
