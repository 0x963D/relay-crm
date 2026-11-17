# Access and security

[Back to Relay CRM](../README.md)

This page covers who can read and change each record, how staff sign in, what the server limits, and what the app's database login may do. One function, `recordScope`, decides scope for every list and every write. The app connects to PostgreSQL as a role that cannot alter a table or rewrite history, so a faulty route still cannot drop a table or edit a ledger line.

## Roles and scope

A person has one of six roles. `recordScope` in `packages/domain/src/access.ts` turns a role, a record kind and an action into a scope.

| Role                  | Leads read                       | Leads edited | Leads assigned                   | Accounts read | Accounts edited |
| --------------------- | -------------------------------- | ------------ | -------------------------------- | ------------- | --------------- |
| Owner, admin, manager | All                              | All          | All                              | All           | All             |
| Team lead             | Their sales team's, and the pool | Their own    | Their sales team's, and the pool | Their team's  | Their own       |
| Agent                 | Their own                        | Their own    | None                             | Their own     | Their own       |
| Accountant            | None                             | None         | None                             | All           | None            |

The team lead row applies when the person's current team is a sales team and their membership marks them as its lead. Without that, a team lead reads and edits only their own records and assigns nothing. A lead can only be assigned to an agent who belongs to a sales team.

A payment follows its account. Whoever reads the account reads its payments, and whoever edits the account can record a payment on it. Four things belong to accountants, managers, admins and owners alone: reading ledger postings and balances, approving a manual payment, closing a payment in review and requeueing a receipt. The other pages call these four roles approvers. An accountant reads every account, with the customer's name and email, and reads no lead record.

Edit and assignment scope never exceed read scope. `recordScope` computes the read scope first and intersects every other scope with it, so a change to the table cannot grant an edit without the read. The test `never lets a $role in $situation edit a lead they cannot read` in [access.test.ts](../packages/domain/test/access.test.ts) runs once for every role and team situation.

```sh
pnpm exec vitest run --project unit packages/domain/test/access.test.ts -t "edit a lead they cannot read"
```

Two functions apply a scope. `scopeAdmits` answers for one record, and `scopeWhere` in `packages/store/src/scope.ts` translates the same scope into a SQL filter for a list. The server never trusts the role it loaded with the session. Each operation loads the person's current role and memberships again inside its own transaction, so a demotion takes effect on the next request.

A record outside the caller's scope and a record that does not exist return the same `accessDenied` refusal.

Three system actors act without a person. `intake` may find a lead by email and reopen a lost one. `providerWebhook` and `reconciler` may settle a card payment, and only `reconciler` may scan for due payments. None of them can read a full record, edit a contact field or assign a lead.

## Sign-in

Existing staff sign in with a six-digit code sent by email. There is no sign-up and no screen for creating users, so a person and their team memberships must already exist in the database.

1. The client posts `{"email":"staff@example.com","type":"sign-in"}` to `/api/auth/email-otp/send-verification-otp`.
2. The server stores a hash of the code and sends the email after it has answered.
3. The client posts `{"email":"staff@example.com","otp":"123456"}` to `/api/auth/sign-in/email-otp` and keeps the session cookie.

A code lasts 5 minutes, and three wrong guesses use it up. An address that belongs to nobody gets the same response as a real one, receives no mail and cannot obtain a session. Both endpoints hold their answer for at least 300 milliseconds, so the response time does not reveal which addresses exist.

Both requests carry JSON, or the URL-encoded fields of the sign-in page's form, and an `Origin` header equal to the origin of `AUTH_URL`. A different origin gets 403. `POST /api/auth/sign-out` ends the session and `GET /api/auth/get-session` reads it. Every other path under `/api/auth` answers 404.

Set `AUTH_SECRET` and `AUTH_URL` to turn sign-in on, and `SMTP_URL` and `SMTP_FROM` to deliver codes. With `AUTH_SECRET` and `AUTH_URL` both unset, sign-in is off and `/api/auth` answers 404. Without SMTP, `pnpm dev` prints each code to the console, and a production server refuses to start. When `AUTH_URL` is an HTTPS origin the session cookie is marked Secure.

With `RELAY_DEMO=1` the server also accepts `POST /api/auth/demo` with `{"role":"manager"}`, `"agent"` or `"accountant"`, and signs the caller in as that seeded person without a code. [The demo page](demo.md#what-a-visitor-can-do) says what that allows.

## Sessions and teams

A session lasts 24 hours. It starts in the person's team when they belong to exactly one. A person with several memberships has no current team until they choose one with `session.selectTeam`, and until then every team-scoped operation returns `teamSelectionRequired`.

## Request limits

PostgreSQL holds every counter in the `auth_request_limits` table, so the limits hold across several app processes. Each budget is a fixed 60-second window that starts with its first request. A refused request gets 429 with `Retry-After: 60`.

| Route                              | Budget per window                                             |
| ---------------------------------- | ------------------------------------------------------------- |
| Sending or checking a sign-in code | 20 per client address across both                             |
| Sending a sign-in code             | 3 per email address                                           |
| Checking a sign-in code            | 10 per email address                                          |
| Both sign-in routes together       | `RELAY_AUTH_GLOBAL_LIMIT` in total, 10,000 by default         |
| Demo sign-in                       | 20 per client address, and `RELAY_AUTH_GLOBAL_LIMIT` in total |
| Web form                           | 10 per client address                                         |
| Web form, all callers              | 1,000 in total                                                |
| Reconcile and outbox job routes    | 5 wrong secrets per client address, counted per route         |

The server checks the client budget first, then the email budget, then the total. A refusal stops the checks, so one flooding client uses up its own 20 and cannot spend the total that every other caller shares. `RELAY_AUTH_GLOBAL_LIMIT` accepts 21 to 1,000,000, which keeps the total above one client's budget. A valid job secret does not count against the wrong-secret budget.

One SQL statement takes a request from a budget. It inserts or increments the row, restarts an expired window, and deletes up to 100 other expired rows that no other statement has locked. A budget at its limit matches no row to update, so the statement returns nothing and the request is refused. The cost is one write per budget on every request to a limited route. In return the limits need no cache and no second service.

## Request body limits

Every route that reads a request body reads it through `readBody` in `apps/web/src/server/http.ts`. The limit is 100,000 bytes, and 1,000,000 bytes for the Meta webhook. A larger body gets 413.

`readBody` refuses a larger declared `Content-Length` without reading the stream. It then counts the bytes it receives and cancels the stream past the limit, so a chunked body with no declared length is held to the same limit. The sign-in routes and `/api/trpc` parse only the copy that passed the count.

## Error responses

A refusal the product intends, such as `accessDenied` or `stalePreview`, reaches the client as a typed code with a message written for a person. [The API page](api.md#refusals) lists the codes.

Anything unexpected returns the fixed message `Something went wrong.` and a generated `requestId`. The server logs the error's class name and its database or Prisma error code beside that ID. It logs neither the error message nor the submitted data, because either can carry an email address. No response contains a stack trace.

## Client addresses and proxies

The per-client budgets need the caller's real address. `RELAY_TRUSTED_PROXY_COUNT` says how many proxies stand in front of the app. It defaults to 0 and accepts 0 to 32.

- With 0, the server uses the address of the TCP connection and ignores `X-Forwarded-For`.
- With a positive count, the server takes the entry that many places from the right of `X-Forwarded-For`. A caller controls only the left of that header, so entries a caller adds are never read. A missing, short or malformed header falls back to the TCP address.

With a positive count, the app's port must be reachable only through the proxy, and each proxy must append the address it saw or overwrite the header. The deployment's network rules have to enforce that. A caller who can reach the port directly can write the whole header and choose their own address.

The server writes IPv4-mapped IPv6 addresses as IPv4 and every IPv6 address in one spelling before it counts.

`pnpm dev` and `pnpm start` run `apps/web/scripts/serve.ts`, which records each connection's address before Next.js handles the request. Development binds `127.0.0.1`. Production binds `HOST`, which defaults to `0.0.0.0`. Running `next start` directly skips that entry point. A request then has no address, and every route that needs one refuses it with the fixed error response and logs the configuration error once.

## Secrets

`AUTH_SECRET`, `RELAY_PAYMENT_WEBHOOK_SECRET`, `RELAY_RECONCILE_SECRET` and `RELAY_OUTBOX_SECRET` each need at least 32 characters and 12 distinct characters. No two of them may be equal, and none may be the placeholder in `.env.example`. The server refuses to start otherwise. These checks catch a repeated letter or a copied example. They do not measure randomness, so generate each secret.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Put each value in the deployment environment and the untracked `.env`.

## Tests for the sections above

- Sign-in, unknown addresses, code expiry, guesses, the sign-in budgets and the fixed error message with its logged request ID: `pnpm exec dotenv -- vitest run --project integration apps/web/test/auth.int.test.ts`
- The web form budgets across two endpoint instances: `pnpm exec dotenv -- vitest run --project integration apps/web/test/web-form.int.test.ts -t "budget|limits anonymous"`
- The body limit at exactly 100,000 and 100,001 bytes: `pnpm exec vitest run --project unit apps/web/test/http.test.ts`
- Forwarded headers, hop counting and address spelling: `pnpm exec vitest run --project unit apps/web/test/client-address.test.ts`
- Secret rules, the proxy count range and the bind address: `pnpm exec vitest run --project unit apps/web/test/env.test.ts`

## The two database roles

`packages/store/scripts/setup-roles.sql` creates two PostgreSQL roles.

- `relay_owner` owns the schema and every table. Migrations, the demo seed and test setup connect as the owner through `MIGRATION_DATABASE_URL`. The owner may create databases, which the integration tests need, and is neither a superuser nor able to create roles.
- `relay_app` is the role the running app uses through `DATABASE_URL`. It owns nothing, belongs to no other role and has no superuser, `CREATEDB`, `CREATEROLE` or `BYPASSRLS` attribute.

The serving app never receives the owner's credentials. A compromised app process is then limited to the grants below. It cannot drop a table, disable a trigger, or update or delete a ledger line.

Eleven history tables are append-only for both roles. A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` on `activities`, `audit_log`, `distribution_previews`, `idempotency_records`, `intake_events`, `ledger_accounts`, `ledger_lines`, `ledger_transactions`, `payment_events`, `payment_makers` and `webhook_inbox`. Only the owner can disable such a trigger. The app cannot read `audit_log`. It can only add to it. Row-level security on `job_leases` shows the app the reconcile and outbox rows and hides the lease that the demo reset holds.

The grants do not make the app's credentials harmless. [Limits](limits.md#what-the-apps-database-credentials-can-still-do) lists what they can still do.

```sh
pnpm exec dotenv -- vitest run --project integration packages/store/test/database-role.int.test.ts packages/store/test/append-only.int.test.ts
```

The first file compares the grants PostgreSQL reports with the tables below. The second attempts an update and a delete on every append-only table as the owner.

### Application grants

| Table                   | Privileges                             |
| ----------------------- | -------------------------------------- |
| `accounts`              | `INSERT`, `SELECT`                     |
| `activities`            | `INSERT`, `SELECT`                     |
| `audit_log`             | `INSERT`                               |
| `auth_accounts`         | `DELETE`, `INSERT`, `SELECT`, `UPDATE` |
| `auth_request_limits`   | `DELETE`, `INSERT`, `SELECT`, `UPDATE` |
| `auth_sessions`         | `DELETE`, `INSERT`, `SELECT`, `UPDATE` |
| `auth_verifications`    | `DELETE`, `INSERT`, `SELECT`, `UPDATE` |
| `demo_seed`             | `SELECT`                               |
| `distribution_previews` | `INSERT`, `SELECT`                     |
| `email_suppressions`    | `SELECT`                               |
| `idempotency_records`   | `INSERT`, `SELECT`                     |
| `intake_events`         | `INSERT`, `SELECT`                     |
| `job_leases`            | `INSERT`, `SELECT`, `UPDATE`           |
| `leads`                 | `INSERT`, `SELECT`, `UPDATE`           |
| `ledger_accounts`       | `INSERT`, `SELECT`                     |
| `ledger_lines`          | `INSERT`, `SELECT`                     |
| `ledger_transactions`   | `INSERT`, `SELECT`                     |
| `memberships`           | `SELECT`                               |
| `outbox`                | `INSERT`, `SELECT`                     |
| `payment_approvals`     | `INSERT`, `SELECT`                     |
| `payment_events`        | `INSERT`, `SELECT`                     |
| `payment_makers`        | `INSERT`, `SELECT`                     |
| `payments`              | `INSERT`, `SELECT`, `UPDATE`           |
| `receipt_attempts`      | `INSERT`, `SELECT`                     |
| `sandbox_checkouts`     | `INSERT`, `SELECT`, `UPDATE`           |
| `teams`                 | `SELECT`                               |
| `users`                 | `INSERT`, `SELECT`, `UPDATE`           |
| `webhook_inbox`         | `INSERT`, `SELECT`                     |

The app may also update these single columns.

| Column                         | Additional privilege |
| ------------------------------ | -------------------- |
| `outbox.cycle_attempts`        | `UPDATE`             |
| `outbox.lease_token`           | `UPDATE`             |
| `outbox.lease_until`           | `UPDATE`             |
| `outbox.next_attempt_at`       | `UPDATE`             |
| `outbox.state`                 | `UPDATE`             |
| `payment_approvals.voided_at`  | `UPDATE`             |
| `receipt_attempts.finished_at` | `UPDATE`             |
| `receipt_attempts.reason`      | `UPDATE`             |
| `receipt_attempts.state`       | `UPDATE`             |
