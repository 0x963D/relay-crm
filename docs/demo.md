# The demo and hosting it

[Back to Relay CRM](../README.md)

This page covers how to run the demo, what its invented company contains, what resets, how long a first run takes and what to change before putting it on a server. The demo is the production build of the app with the sandbox provider and shared logins turned on. It runs the same code as any other deployment, and everything a visitor changes is gone at the next midnight in the demo's time zone.

## Run the demo

Install Docker and Docker Compose, then run this in the repository.

```sh
docker compose up
```

Wait until `docker compose ps` shows the `app` service as healthy, then open the app at <http://127.0.0.1:3107> and the mail inbox at <http://127.0.0.1:8127>. Those two ports are the only ones published, and both bind to `127.0.0.1`. The database has no published port. `docker compose config` prints the ports and settings Compose will use.

`GET /api/health` answers with an empty 200 once the migrations and the seed have finished, and 503 before that.

To run a second copy, give it its own project name and free ports. This is the command in a POSIX shell.

```sh
COMPOSE_PROJECT_NAME=relay-second RELAY_HTTP_PORT=3117 RELAY_INBOX_PORT=8137 docker compose up
```

Pass the same variables to every later Compose command for that copy. `RELAY_TIME_ZONE` sets the time zone whose midnight starts a new day for callbacks and for the reset. It defaults to UTC.

`docker compose down --volumes` removes the containers and every volume, including the inbox.

## What is in it

The company is Tidewell Language School, and it is invented. The sign-in page has a button for each of three people.

| Person        | Role       | Opens on                             |
| ------------- | ---------- | ------------------------------------ |
| Priya Raman   | Manager    | The lead pool                        |
| Dele Akinwale | Agent      | A callback queue with ten open leads |
| Esther Okafor | Accountant | Payments                             |

Four more people are seeded without a button: a second manager and three more agents. They own leads and accounts, take their turn in round-robin and recorded some of the seeded payments.

The seed does not insert finished rows. It calls the operations the app calls, through the app's database role: intake for every lead, assignment by the manager, logged attempts, closes, card checkouts, webhooks and two-person approvals. Every seeded lead and payment has therefore passed the same rules as one a visitor creates. The owner role writes only the teams, the people, one suppressed email address and the seed marker.

Dele's queue has two leads in each of its five groups, and the demo check below asserts those counts. Two of the leads have callbacks due today, at 20:00 and 22:00 in the demo's time zone, so one moves to overdue after 20:00 and the other after 22:00.

The funnel covers Meta Lead Ads campaigns, the web form and a CSV import with no campaign. The payments screen opens with a payment in each state worth seeing: waiting for approval, waiting for the provider, in review for an amount mismatch, in review because it was paid after it expired, and completed by the reconciler ahead of a late webhook. Seeded receipts show the outcomes a working mail server never produces: one failed, one unknown, one suppressed and one at its lifetime attempt limit.

## The services

| Service     | Image                 | What it does                                                                          |
| ----------- | --------------------- | ------------------------------------------------------------------------------------- |
| `secrets`   | Node.js               | Runs once. Generates passwords and secrets into four private volumes                  |
| `db`        | PostgreSQL 17         | Creates the owner and app roles on first start                                        |
| `mail`      | Mailpit               | Receives every email the demo sends and shows it in the inbox                         |
| `app`       | The app image         | Serves the app as `relay_app`, with no owner credentials                              |
| `resetter`  | The maintenance image | Holds the owner connection. Applies migrations, seeds, and restores the demo each day |
| `scheduler` | The maintenance image | Calls the reconcile and outbox routes once a minute with their secrets                |

Each service mounts only its own configuration volume. The app and the scheduler never see the owner's database password, and only the resetter can change the schema or wipe data. The scheduler has no database access at all. It reaches the two jobs through the same authenticated HTTP routes an outside scheduler would use.

The app image contains the standalone Next.js output and runs as the `node` user. The maintenance image keeps the whole workspace, because migrations and the seed need Prisma and the TypeScript sources.

The demo checks card payments sooner than the defaults. The first check has no delay, later checks come a minute apart and the sandbox's late webhook waits a minute. [Payments](payments.md#the-reconciler) gives the defaults.

## What resets

At each midnight in `RELAY_TIME_ZONE`, the resetter restores the demo. In one owner transaction it empties every table except the migration history, the seed marker and the job leases, then seeds again. A reset that fails rolls back and leaves the previous data in place.

A reset ends every session, so each visitor signs in again. The inbox is not part of the database and keeps its mail across resets.

This command restores a running demo without waiting for midnight.

```sh
docker compose exec -T resetter node --import tsx apps/web/scripts/demo-reset.ts --container
```

The first seed is not one transaction. If it is interrupted, the seed marker stays in the state `building` and the app answers every request with 503. The resetter restores the demo when it next starts.

## What a visitor can do

These follow from shared logins and invented data. None of them is acceptable with real data.

- The three logins are shared. One visitor can record a manual payment as the agent and give it both approvals as the manager and the accountant.
- The inbox keeps every message. Anyone who can open it can read a sign-in code and sign in by email as any seeded person.
- The web form is public. A submitted email address becomes a lead, and a submission for a lost lead reopens it.
- Whatever a visitor changes stays until the next reset.

## Host it

The Compose file is for one machine. To host the demo elsewhere, give the app these settings. The app image reads them from a JSON file at `/run/relay-secrets/app/config.json`, and `pnpm start` reads them from the environment.

| Setting                                                                                        | Value                                                                                        |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `RELAY_DEMO`, `RELAY_SANDBOX`                                                                  | `1`                                                                                          |
| `DATABASE_URL`                                                                                 | The `relay_app` connection                                                                   |
| `AUTH_URL`, `RELAY_SANDBOX_URL`                                                                | The public HTTPS origin                                                                      |
| `AUTH_SECRET`, `RELAY_PAYMENT_WEBHOOK_SECRET`, `RELAY_RECONCILE_SECRET`, `RELAY_OUTBOX_SECRET` | Four different [generated secrets](access-security.md#secrets)                               |
| `SMTP_URL`, `SMTP_FROM`                                                                        | A mail sink you control                                                                      |
| `RELAY_TIME_ZONE`                                                                              | The time zone for callbacks and the reset                                                    |
| `RELAY_TRUSTED_PROXY_COUNT`                                                                    | The number of [proxies in front of the app](access-security.md#client-addresses-and-proxies) |

Four rules matter more than the settings.

- Keep the owner connection in a separate maintenance process, as the resetter does.
- Do not publish the mail inbox. A sign-in code read from it opens a session as any seeded person.
- Do not publish PostgreSQL, and do not bind the app or the inbox to every interface of the host.
- Call `POST /api/payments/reconcile` and `POST /api/payments/outbox` on a schedule. Without them a dropped webhook is never recovered and no receipt is sent.

## Update a pinned image

`compose.yaml` and `Dockerfile` pin each upstream image by tag and by manifest digest. To move to a new tag, read its digest and replace both values.

```sh
docker buildx imagetools inspect postgres:17
```

Then run the demo check below before committing.

## First-run measurements

One run on one machine on 17 November 2026 took 149,781 ms from `docker compose up` to a working demo. It is a single measurement and not a guarantee.

The timer stops after the health check passes, all three people have signed in, and the queue, payments, accounts and one ledger have been read. The three upstream images were already on the machine. The app was built in a new builder with an empty cache, so the time includes pulling the Node.js base image into that builder and installing every package.

| Measured                              |         Bytes |
| ------------------------------------- | ------------: |
| App image                             |   410,573,994 |
| Maintenance image                     | 2,791,583,826 |
| All five images the demo uses, summed | 4,241,968,997 |

The sum counts layers that two images share more than once. The builder's cache held a further 2.933 GB. These are the sizes Docker reports for images and cache. They are not the growth in disk use on the host, and the database and inbox volumes come on top.

The timing comes from `pnpm demo:check`, which needs the development dependencies from `pnpm install --frozen-lockfile`. To repeat it with an empty build cache, pick a new builder name and a new project name.

```sh
docker buildx create --name relay-measure-builder --driver docker-container
BUILDX_BUILDER=relay-measure-builder COMPOSE_PROJECT_NAME=relay-measure pnpm demo:check ../relay-demo-evidence --cold
```

The check prints the time as `wallMs` on its `QUICKSTART` line. It then pays one sandbox checkout and waits for its webhook, pays a second with the webhook dropped and waits for the scheduler to recover it, reads the receipt from the inbox, resets the demo and confirms that the sessions ended and the visitor's payment is gone. `--cold` refuses to start if the project's images already exist. When the check ends it removes its containers and volumes, and with `--cold` the images it built. The directory argument must be outside the repository.

While the check's project is up, these commands in a second terminal report the two image sizes, the sum over the project's five images and the builder's cache.

```sh
export COMPOSE_PROJECT_NAME=relay-measure
docker image inspect "${COMPOSE_PROJECT_NAME}-app:local" "${COMPOSE_PROJECT_NAME}-maintenance:local" --format '{{index .RepoTags 0}} {{.Size}}'
docker image inspect $(docker compose images -q | sort -u) --format '{{.Size}}' | node -e 'let text=""; process.stdin.on("data", chunk => text += chunk).on("end", () => console.log(text.trim().split(/\s+/).reduce((sum, size) => sum + Number(size), 0)))'
docker buildx du --builder relay-measure-builder
```

Remove the builder afterwards with `docker buildx rm relay-measure-builder`. The check does not clear Docker's shared build cache.
