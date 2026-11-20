# Host the public demo

This guide sets up a public demo with shared logins and invented data. The configuration disables email codes and receipt delivery. Completed payments still create a receipt record, and the receipt worker marks delivery as suppressed. The first successful maintenance run after midnight in the configured time zone resets the demo. Use [Docker Compose](demo.md#run-the-demo) for the local one-command demo with a mail inbox.

## Prepare and release

1. **Select the release.** Land the reviewed change on `main` and record its full commit SHA. Use that SHA for the remote build. Keep `main` at the intended release while you run first-time setup.
2. **Prepare PostgreSQL 17.** Create a dedicated demo database in a region close to the web functions. For Neon, create the project with PostgreSQL 17 and enter the connections manually. An automatic project connection can inject privileged aliases into the deployment. [Neon integration variables](https://neon.com/docs/guides/vercel-managed-integration).
3. **Set up database roles.** On the new database, run [the role bootstrap](../packages/store/scripts/setup-roles.sql) through the direct administrative connection with the `owner_password` and `app_password` psql variables. The bootstrap works on stock PostgreSQL 17 as a superuser or as a database-owning administrator with `CREATEROLE` and `CREATEDB`. The limited-administrator proof runs with `pnpm exec tsx packages/store/test/setup-roles-proof.ts` and starts a disposable `postgres:17` container. No managed provider has been tested. Repeat the checks on a disposable provider database before using it for the demo. `relay_owner` owns the database, `public` schema and migrated objects. `relay_app` has no privileged attributes, memberships or ownership. Migrations grant its application access. [Neon role privileges](https://neon.com/docs/manage/roles), [PostgreSQL role attributes](https://www.postgresql.org/docs/17/sql-alterrole.html).
4. **Configure maintenance.** In GitHub, set `main` as the default branch and create the `demo-maintenance` environment. Restrict deployment branches to `main` and store the two direct URLs in its environment secrets. Scheduled runs must be able to proceed without a manual approval. Protect `main` and review changes to the workflow before merging. [GitHub environment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
5. **Migrate and seed.** Run **Demo maintenance** manually on `main`. Confirm the workflow ran for the selected commit and reports a ready seed. Then set the repository variable `DEMO_MAINTENANCE` to `on`. Hourly runs are skipped until it is set. Only manual dispatch runs migrations. The hourly run checks that the database has the latest migration required by its `main` commit before it writes. It recovers an interrupted seed and resets a demo seeded before the current local day. GitHub can delay or skip scheduled runs, and disables them after 60 days of inactivity in a public repository. [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
6. **Configure the Vercel project.** Use the Next.js preset and set the root to `apps/web`. Enable access to workspace sources outside the root, automatic system environment variables and Fluid Compute. Use `main` as the Production Branch. Set the Production variables below and leave Preview without credentials. The checked-in configuration disables Git-triggered builds, installs from the frozen workspace lockfile, generates the Prisma client and builds the app. [Vercel monorepos](https://vercel.com/docs/monorepos), [Corepack](https://vercel.com/docs/builds/configure-a-build#corepack).
7. **Build the exact commit.** In the project's Deployments tab, choose **Create Deployment** and enter the full SHA from step 1. Select the `main` configuration if asked. Wait for the remote build and verify its Git SHA, Node 24 and pnpm 11.18.0 in the deployment details and logs. [Create a deployment by commit](https://vercel.com/changelog/manually-create-deployments-by-commit-or-branch-in-the-dashboard).
8. **Point the domain and verify.** Add your chosen domain to the project and set the DNS record Vercel provides. Use the HTTPS domain directly through Vercel for its verified client-address header. Check `GET /api/health` for an empty 200. Sign in as each demo role, submit the public form with invented data, and try the sandbox's normal, duplicate, late and dropped webhook modes. Confirm one ledger posting per completed payment and a suppressed receipt. Confirm an actual run for `demo-payments` in the Production Schedules history and leave Preview schedules inactive. [Vercel request headers](https://vercel.com/docs/headers/request-headers#x-forwarded-for).

For later releases, repeat migration and seed preparation when the schema changes. A scheduled maintenance run against an older schema fails before touching demo data.

## Vercel Production settings

| Variable                        | Value                                                                   |
| ------------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`                  | TLS-enabled pooled PostgreSQL URL for `relay_app` on the demo database. |
| `AUTH_URL`, `RELAY_SANDBOX_URL` | Your demo HTTPS origin, for example `https://relay.example.com`.        |
| `AUTH_SECRET`                   | Secret for sessions.                                                    |
| `RELAY_PAYMENT_WEBHOOK_SECRET`  | Secret for signed sandbox callbacks.                                    |
| `RELAY_RECONCILE_SECRET`        | Secret for `POST /api/payments/reconcile`.                              |
| `RELAY_OUTBOX_SECRET`           | Secret for `POST /api/payments/outbox`.                                 |
| `CRON_SECRET`                   | Secret for `POST /api/demo/jobs`. Schedules sends it as a bearer token. |
| `RELAY_DEMO`, `RELAY_SANDBOX`   | `1`                                                                     |
| `RELAY_EMAIL_MODE`              | `disabled`                                                              |
| `RELAY_TRUSTED_PROXY_COUNT`     | `1` for direct traffic through Vercel.                                  |
| `RELAY_RECONCILE_FIRST_MS`      | `0`. An eligible payment can be picked up at the next check.            |
| `RELAY_RECONCILE_INTERVAL_MS`   | `60000`. Sets when a payment is eligible again after a check.           |
| `RELAY_SANDBOX_LATE_MS`         | `60000`. Delay for the sandbox's late webhook mode.                     |
| `RELAY_TIME_ZONE`               | `UTC`, matching maintenance.                                            |
| `RELAY_PUBLIC_FORM`             | `1`                                                                     |
| `ENABLE_EXPERIMENTAL_COREPACK`  | `1` for the build.                                                      |

For the web server, `RELAY_EMAIL_MODE=disabled` requires the restricted database login, an explicit trusted proxy count and a schedule secret on any platform. For a single trusted proxy, set `RELAY_TRUSTED_PROXY_COUNT=1` and restrict traffic to that proxy. Keep its forwarding header under proxy control. Direct serving through the Relay HTTP entry point can use `0` because the entry point reads the socket peer. A server launched through raw `next start` requires a positive proxy count for the no-email demo. Generate five different values as described in [Secrets](access-security.md#secrets). Each needs at least 32 characters and at least 12 distinct characters. Redeploy the intended Git commit after changing `CRON_SECRET` so the path schedule and the app use the same value.

Leave `SMTP_URL`, `SMTP_FROM`, `RELAY_SANDBOX_DELIVERY_URL`, `RELAY_DEV_ACTOR`, `RELAY_DEV_ROLE`, `META_VERIFY_TOKEN`, `META_APP_SECRET`, `META_ACCESS_TOKEN`, `META_GRAPH_VERSION` and `META_GRAPH_BASE_URL` unset. Keep `MIGRATION_DATABASE_URL` and any provider-injected administrative URLs or credential aliases out of the project, including its build environment. Set no database URLs or secrets in Preview.

The defaults are `RELAY_AUTH_GLOBAL_LIMIT=10000`, `RELAY_CHECKOUT_TTL_MS=86400000`, `RELAY_RECEIPT_LEASE_MS=60000`, `RELAY_RECEIPT_SEND_TIMEOUT_MS=30000` and `RELAY_RECEIPT_LIFETIME_ATTEMPTS=12`. The build uses `VERCEL` to select its output format. Next.js supplies the internal `RELAY_DEVELOPMENT_BUILD` marker. The app reuses a pool with up to five connections per hosted process and a ten-second connection timeout for database wake-up.

## GitHub maintenance environment

| Variable                 | Location and value                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | Environment secret. TLS-enabled **direct** URL for `relay_app`.                                 |
| `MIGRATION_DATABASE_URL` | Environment secret. TLS-enabled **direct** URL for `relay_owner` on the same host and database. |
| `RELAY_DEMO`             | Workflow sets `1`.                                                                              |
| `RELAY_EMAIL_MODE`       | Workflow sets `disabled`.                                                                       |
| `RELAY_TIME_ZONE`        | Workflow sets `UTC`. Change it in both environments together.                                   |
| `NODE_ENV`               | Workflow sets `production` for maintenance after dependency installation.                       |

## Payment schedule

[The Vercel Schedule in the manifest](../apps/web/vercel.json) is configured to send a POST to `/api/demo/jobs` every 15 minutes. The route runs reconciliation and then the receipt outbox in the same process. If a job already holds its lease, the response reports `429` for that job and the route still attempts the other job. Schedules can run late or miss a run, and a later cycle picks up work that is still due. On Hobby, the dispatch window is 15 minutes. This cadence gives a scale-to-zero database idle time between runs when there is no other traffic. [Vercel Schedules limits](https://vercel.com/docs/schedules/limits), [Schedule delivery](https://vercel.com/docs/schedules/concepts).

With an always-on database and Vercel Pro, you can check once a minute. Change the `"schedule": "*/15 * * * *"` line in [`apps/web/vercel.json`](../apps/web/vercel.json) to `"schedule": "* * * * *"`, then build that commit. Leave timing room for dispatch delay. [Vercel Schedules limits](https://vercel.com/docs/schedules/limits).
