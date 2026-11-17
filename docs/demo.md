# The demo and hosting it

[Back to Relay CRM](../README.md)

## Run the demo

The seeded queue shows all five groups from 00:00 until 22:00 in the configured local time zone, with two due-today callbacks before 20:00.

Install Docker and Docker Compose, then run this command in the repository.

```sh
docker compose up
```

Wait until `docker compose ps` shows `app` as healthy. `GET /api/health` returns an empty 200
response when migrations and the seed are ready. During setup or a reset it returns 503.
Open the app at <http://127.0.0.1:3107> and the inbox at <http://127.0.0.1:8127>.
These are the only published ports. Both bind to loopback, and the database has no published port.
`docker compose config` prints the effective ports and service configuration.

The upstream images in `compose.yaml` and `Dockerfile` pin a tag and its manifest digest.
To update one, choose its new tag, run `docker buildx imagetools inspect <image>:<tag>`, and replace
both the tag and the `sha256` digest with that manifest's values.
Run `pnpm demo:check <evidence-directory>` before committing the update.

To run another copy, choose a different project name and free ports. In a POSIX shell, for example,
run `COMPOSE_PROJECT_NAME=relay-second RELAY_HTTP_PORT=3117 RELAY_INBOX_PORT=8137 docker compose up`.
Use the same variables with later Compose commands. `RELAY_TIME_ZONE` selects the local day for
callbacks and reset, and defaults to UTC.

The invented company is Tidewell Language School. The sign-in page offers Priya Raman, manager,
Dele Akinwale, agent, and Esther Okafor, accountant. The manager opens the lead pool, and the agent
opens a queue with five groups. The accountant opens Payments. Staff can also sign in with an emailed code.
The lead screens support assignment by hand, round-robin previews, attempts, callbacks, notes and
closing a lead. A rejected preview assigns nothing. Only "Spoke to them" marks a lead contacted.
Payments, the ledger, the funnel and the accounts list have screens backed by typed APIs.

The data is invented and resets at the start of the next local day.
The demo's logins are shared, so one visitor can give a manual payment both approvals.
The demo's inbox keeps every message, and anyone who can open it can sign in by emailed code as any of the invented staff.
The demo checks card payments more often than a production setup would, and payment API reads return its configured first-check delay and interval.
The public form stores a submitted email as a lead and can reopen a lost lead.
A visitor can leave data changed until the next reset.

Compose creates private configuration files in separate volumes. The resetter holds the owner
connection, applies migrations, recovers an interrupted seed and restores the demo each local day.
The app connects as `relay_app`; the app and scheduler never receive the owner's credentials.
The scheduler calls reconciliation and the outbox through their authenticated HTTP routes.
The inbox retains mail across database resets. `docker compose down --volumes` removes the
project's containers and volumes, including that inbox.

To restore a running demo, run
`docker compose exec -T resetter node --import tsx apps/web/scripts/demo-reset.ts --container`.
It ends every session. For a separately configured local database, `pnpm db:seed` requires the
owner and app URLs and an SMTP sink. Repeating it on a ready seed changes nothing.
`pnpm demo:reset` uses the owner connection and requires `RELAY_DEMO=1` and the owner-only marker.
A marker left at `building` makes startup restore the seed before serving requests.

The seed follows the funnel's received, pool, contacted and won totals and keeps the named payment stories. History uses local working hours across the preceding fortnight.
Failed, unknown, suppressed and capped receipts are seeded outcomes. They remain visible even when the inbox accepts every message. New successful receipts go to the SMTP sink. Leila's receipt uses explicit demo suppression because intake requires an email address.

For a hosted demo, configure `RELAY_DEMO`, `RELAY_SANDBOX`, `AUTH_URL`, `RELAY_SANDBOX_URL`,
`DATABASE_URL`, `SMTP_URL`, `SMTP_FROM`, `RELAY_TIME_ZONE` and the proxy count. Use distinct auth,
webhook, reconcile and outbox secrets. Keep the owner connection in a separate maintenance process.
Point SMTP at a controlled sink. Do not publish the mail inbox, because a sign-in code read from it opens a session as any seeded staff member.
Set `AUTH_URL` to the HTTPS origin so the session cookie is marked Secure.
Do not publish PostgreSQL or bind the app or the inbox to all interfaces.

## First-run measurements

A fresh-clone run on 17 November 2026 took **146,660 ms**. Service images were already present. The application build cache was empty in a dedicated builder. This is one run on one machine, not a timing guarantee.

| Image                            |      Bytes |
| -------------------------------- | ---------: |
| App                              |  410629247 |
| Maintenance                      | 2731518828 |
| All five required images, summed | 4181959252 |

The maintenance image retains migration and seed tools. The app contains standalone output and runs as `node`. The sum counts shared layers more than once. The dedicated build cache reported **2.815 GB**. Database and inbox volumes are additional. These are Docker-reported image and cache sizes, not an exact increase in host disk use. The commands below produced the timing and size reports. Use fresh names for a repeat run.

The timer in `pnpm demo:check <evidence-directory> --cold` starts at `docker compose up` and ends after readiness, role sign-ins and initial queue, payment and ledger reads. The check then tests webhook delivery, scheduled recovery, SMTP delivery and an owner-side reset. It needs the development dependencies from `pnpm install --frozen-lockfile`. Add `--browser` to run the browser journeys too. That option also needs `pnpm db:generate` and `pnpm exec playwright install chromium` in the host clone.

To repeat the timing with an empty application build cache, choose fresh builder and project names.

```sh
docker buildx create --name relay-measure-builder --driver docker-container
BUILDX_BUILDER=relay-measure-builder COMPOSE_PROJECT_NAME=relay-measure pnpm demo:check ../relay-demo-evidence --cold
```

In another terminal, while that check's project is up, these commands report the app and maintenance
sizes, the sum of all distinct project images, and the dedicated cache size.

```sh
export COMPOSE_PROJECT_NAME=relay-measure
docker image inspect "${COMPOSE_PROJECT_NAME}-app:local" "${COMPOSE_PROJECT_NAME}-maintenance:local" --format '{{index .RepoTags 0}} {{.Size}}'
docker image inspect $(docker compose images -q | sort -u) --format '{{.Size}}' | node -e 'let text=""; process.stdin.on("data", chunk => text += chunk).on("end", () => console.log(text.trim().split(/\s+/).reduce((sum, size) => sum + Number(size), 0)))'
docker buildx du --builder relay-measure-builder
```

`--cold` requires absent project images. It refuses to remove a pre-existing image. The check
removes its containers and volumes, and with `--cold` removes only the project images it created.
It does not clear Docker's shared build cache. Remove a dedicated measurement builder with
`docker buildx rm relay-measure-builder` when finished.
