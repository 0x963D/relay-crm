---
name: verify-relay-crm
description: Verify Relay CRM changes through the local Compose demo, browser role journeys, and PostgreSQL tests.
---

# Verify Relay CRM

## Launch and check readiness

Pick a fresh project name, such as `relay-verify-` and eight hex digits, and two free loopback ports. Type the name literally after `-p` in every Compose command. A shell variable does not survive when each command starts a new shell, and Compose then falls back to the folder name. In the primary checkout that name is `relay-crm`, the owner's own demo. Never run `docker compose down --volumes` without `-p`.

From the worktree root in PowerShell, with `relay-verify-1a2b3c4d` standing for your name:

```powershell
$env:RELAY_HTTP_BIND = '127.0.0.1'; $env:RELAY_HTTP_PORT = '3117'; $env:RELAY_INBOX_PORT = '8137'; docker compose -p relay-verify-1a2b3c4d up -d --wait
docker compose -p relay-verify-1a2b3c4d ps
Invoke-WebRequest 'http://127.0.0.1:3117/api/health' | Select-Object StatusCode
```

The port settings matter only to `up`, so they share its line. Drive the app once `app` is healthy and the health endpoint returns 200. Open the app on the HTTP port and Mailpit on the inbox port. Use only the seeded company and invented inputs.

For an automated run, `pnpm demo:check <directory>` replaces `up`. It needs the workspace dependencies and an evidence directory outside the checkout, runs the README quickstart, and removes its own containers and volumes. It reads the project name from the environment, so set it on the same line. It refuses a project that already has containers or volumes.

```powershell
$env:COMPOSE_PROJECT_NAME = 'relay-verify-1a2b3c4d'; $env:RELAY_HTTP_PORT = '3117'; $env:RELAY_INBOX_PORT = '8137'; pnpm demo:check ..\relay-verify-evidence --cold
```

`--cold` refuses existing project images and removes the images it built. Add `--browser` to run the published browser journeys in Chromium. A new buildx builder gives an empty build cache for first-run measurements. [Demo check](../../../docs/demo.md#first-run-measurements)

## Role journeys

Follow the controls in [Three things to try](../../../README.md#three-things-to-try). Use the role switcher to change roles after sign-in.

| Role                                                 | Journey                                                                                                                    | Evidence                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Priya Raman, manager                                 | Lead pool. Preview and confirm a round-robin assignment of two leads.                                                      | Preview names the owners, confirmation reports two assignments, and the leads leave the pool.               |
| Dele Akinwale, agent                                 | Queue. Open Hye-jin Park, log a **Spoke to them** attempt with a distinct note, then close as won if verifying conversion. | **Attempt saved** and the note in the timeline after reload. For conversion, **An account was opened**.     |
| Dele Akinwale, agent, then Esther Okafor, accountant | Open Leila Farouk's account, make the sandbox card payment with **Drop it**, then open the payment as accountant.          | **Credited once**, **The reconciler**, and one ledger posting. Check Mailpit if verifying receipt delivery. |

## Run the checks

The [development commands](../../../docs/development.md#commands) list every check, and [CI](../../../.github/workflows/ci.yml) shows the setup each one needs. Run `pnpm install --frozen-lockfile` and `pnpm db:generate` in the worktree first. When the pnpm store already holds the packages, `--offline` links them without downloading anything.

Database checks need a disposable PostgreSQL 17 server with the [two roles](../../../docs/development.md#run-it-without-docker). In Docker, give it a unique name and a free loopback port. PowerShell has no `<` redirection, so pipe the role script in.

```powershell
docker run --name relay-verify-pg-1a2b3c4d -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay -e POSTGRES_DB=relay -p 127.0.0.1:54339:5432 -d postgres:17
Get-Content -Raw packages/store/scripts/setup-roles.sql | docker exec -i relay-verify-pg-1a2b3c4d psql -U relay -d relay -v owner_password=fake-local-owner-password -v app_password=fake-local-app-password
```

Each check reads `DATABASE_URL` and `MIGRATION_DATABASE_URL` from the environment or from `.env`. Set them on the same line as the check, because a new shell drops them. The integration setup migrates its own template database, so no separate `pnpm db:migrate` is needed.

```powershell
$env:DATABASE_URL = 'postgresql://relay_app:fake-local-app-password@127.0.0.1:54339/relay'; $env:MIGRATION_DATABASE_URL = 'postgresql://relay_owner:fake-local-owner-password@127.0.0.1:54339/relay'; pnpm test:int
```

- `pnpm test:int` covers store and API behavior.
- `pnpm build`, then `pnpm test:browser` with the same two URLs, runs the built-app suite in Chromium. Evidence goes to `test-results/evidence/playwright/` unless `RELAY_EVIDENCE_DIR` names another directory. The suite needs the Chromium build that the pinned Playwright expects. If it is missing, installing it is a browser download, so ask the owner first.
- To prove the queue test catches a broken rule, start with a clean `packages/store/src/work.ts`. Run `pnpm test:mutations test-results/verify-relay-crm/queue work-note-attempt` with the two URLs. Keep the failing assertion, the restored pass and `results.json`, and confirm `git diff --exit-code HEAD -- packages/store/src/work.ts` passes.

Run database checks one at a time. They rebuild the same template database, and the mutation runner temporarily rewrites source. On Docker Desktop for Windows a full `pnpm test:int` takes about 18 minutes, and a slow host can fail a test with `P2028 Unable to start a transaction in the given time`. Rerun that file alone before treating it as a regression.

## Save evidence and clean up

Keep screenshots, test output, and exit statuses under `test-results/verify-relay-crm/`. Capture each action and its visible result. Keep the automated demo output in the directory passed to `demo:check`.

For a manually launched demo, run the teardown with the literal project name, even after a failed check. Remove the two images Compose built for that name, and confirm that nothing with the name's label is left.

```powershell
docker compose -p relay-verify-1a2b3c4d down --volumes
docker image rm relay-verify-1a2b3c4d-app:local relay-verify-1a2b3c4d-maintenance:local
docker ps -aq --filter label=com.docker.compose.project=relay-verify-1a2b3c4d
docker volume ls -q --filter label=com.docker.compose.project=relay-verify-1a2b3c4d
```

The last two commands must print nothing, after `demo:check` as well. Remove a standalone test database container by its exact name with `docker rm --force --volumes <name>`, which also drops its anonymous data volume, and confirm `docker ps -a --filter name=^<name>$` lists nothing. Keep the evidence.
