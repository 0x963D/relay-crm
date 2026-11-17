# Access and security

[Back to Relay CRM](../README.md)

- Existing staff sign in with an expiring email code. There is no sign-up. Unknown addresses
  receive the same response, get no mail and cannot obtain a session. Codes have limited guesses,
  and PostgreSQL stores request limits across application processes.
- A session starts in its sole team when the user has exactly one membership. With several
  memberships, `session.current` returns the choices. Team-scoped operations require a selection
  and return `teamSelectionRequired` until the user chooses. The server reloads current roles
  and memberships inside each human record operation's transaction.
- `recordScope` in `packages/domain/src/access.ts` decides all record and target-agent scope.
  `scopeAdmits` applies that scope to a record. `scopeWhere` in `packages/store/src/scope.ts`
  only translates it into a SQL filter. Lists and individual operations use those same decisions.
  Agents read and edit their own records. Sales team leads read their team's leads and the pool,
  assign within that team, and edit owned records that their read scope also admits.
  Managers, admins and owners see and edit everything. Accountants read every account, including
  the name and email of the person it was opened for. They cannot read lead records, edit or assign. Edit and assignment scopes always stay within read scope.

`RELAY_TRUSTED_PROXY_COUNT` defaults to 0. `pnpm exec vitest run --project unit apps/web/test/client-address.test.ts`
checks that 0 ignores all forwarded headers and uses the TCP peer. A positive setting selects
that many hops from the right of `X-Forwarded-For`. An invalid address or a shorter chain falls
back to the TCP peer. When `RELAY_TRUSTED_PROXY_COUNT` is above zero, the app's port must be
reachable only through the proxy. A direct connection can forge the forwarded header, so enforce
that restriction with the deployment's network rules. Configure the exact proxy count. Each proxy
must append the peer address or overwrite the header with a verified chain.
IPv4-mapped IPv6 and IPv6 spellings are canonicalized before counting.

Use `pnpm dev` and `pnpm start`. Development always binds `127.0.0.1`. Production uses `HOST`,
defaulting to `0.0.0.0`. `pnpm exec vitest run --project unit apps/web/test/env.test.ts` checks those choices. Their Node HTTP entry point captures the connection address
in request-local storage before Next handles the request. Running `next start` directly lacks
that context. A request without either a socket address or a trusted forwarded address is refused
with the fixed error response. The server logs the missing-address configuration error once.
No shared fallback budget is created. `pnpm test:prod` checks this through plain `next start`.
`pnpm exec vitest run --project unit apps/web/test/env.test.ts` checks that the proxy count is an integer from 0 to 32.

## Sign-in request limits

`pnpm exec dotenv -- vitest run --project integration apps/web/test/auth.int.test.ts` verifies these PostgreSQL budgets.
All use 60-second fixed windows and return the same 429 body and `Retry-After: 60` for known
and unknown email addresses. Timing padding also applies to a refused request.

The client address has 20 requests across code issuance and verification. Code issuance has
3 requests per normalized email address. Verification has 10 per normalized email address.
Client identity follows `RELAY_TRUSTED_PROXY_COUNT`, just as the form does.
The client budget is checked first, then the email budget, then the global circuit breaker.
A refusal stops those checks, so it cannot consume the later budgets.

`RELAY_AUTH_GLOBAL_LIMIT` defaults to 10,000 requests per window across both operations.
`pnpm exec vitest run --project unit apps/web/test/env.test.ts` verifies that its configured value is an integer from
21 to 1,000,000. Its minimum stays above a single client's budget.

## Error responses

`pnpm exec dotenv -- vitest run --project integration apps/web/test/rpc.int.test.ts apps/web/test/auth.int.test.ts` verifies that
unexpected failures return `Something went wrong.` and a generated `requestId`. The server
logs the error class and code with that ID, without its message or submitted data.
The tRPC formatter preserves typed domain failures in
`data.accessFailure` and their messages. It removes stack traces from every error response.
The auth and intake HTTP boundaries catch unexpected exceptions. The form keeps its retryable
503 response for intake failures, with the same fixed message and a logged request ID.

## Request body limits

`pnpm exec vitest run --project unit apps/web/test/http.test.ts` verifies the shared streaming reader's exact boundary.
Auth, tRPC and the public form accept at most 100,000 body bytes and return 413 above that limit.
The reader checks the declared length first, then counts actual bytes, including chunked bodies,
and cancels the stream when the limit is exceeded. Auth and tRPC parse only the bounded copy.
`pnpm test:prod` sends JSON containing 2,000,000 padding characters to those routes, including sign-out, and expects 413.
The signed Meta webhook keeps its separate 1,000,000-byte limit, checked by
`pnpm exec vitest run --project unit apps/web/test/meta-webhook.test.ts`.

## Generate an authentication secret

Generate a secret locally, then put it in your deployment environment and untracked `.env`.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`pnpm exec vitest run --project unit apps/web/test/env.test.ts` verifies that `AUTH_SECRET`, `RELAY_PAYMENT_WEBHOOK_SECRET`,
`RELAY_RECONCILE_SECRET` and `RELAY_OUTBOX_SECRET` each need at least
32 characters and 12 distinct characters, and refuses the exact placeholder in `.env.example`.
Configured secrets must be pairwise distinct. These checks reject obvious weak values. They do not measure entropy. Use the generator rather
than a phrase that happens to pass the checks. `pnpm test:prod` verifies startup refusal for a
repeated-letter secret and for the placeholder. Empty `AUTH_SECRET` leaves sign-in off when
`AUTH_URL` and SMTP are also unset.

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
