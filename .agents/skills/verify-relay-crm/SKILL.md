---
name: verify-relay-crm
description: Verify Relay CRM changes through the local Compose demo, browser role journeys, and PostgreSQL tests.
---

# Verify Relay CRM

## Launch and check readiness

Use a fresh Compose project name and two free loopback ports. From the worktree root in PowerShell, keep these settings for every Compose command in the run.

```powershell
$env:COMPOSE_PROJECT_NAME = 'relay-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$env:RELAY_HTTP_BIND = '127.0.0.1'
$env:RELAY_HTTP_PORT = '3117'
$env:RELAY_INBOX_PORT = '8137'
docker compose up -d --wait
docker compose ps
Invoke-WebRequest "http://127.0.0.1:$env:RELAY_HTTP_PORT/api/health" | Select-Object StatusCode
```

Drive the app once `app` is healthy and the health endpoint returns 200. Open the app on `RELAY_HTTP_PORT` and Mailpit on `RELAY_INBOX_PORT`. Use only the seeded company and invented inputs.

If `docker compose logs resetter` shows `EACCES` from an attempted dependency install during `pnpm db:migrate`, clean up the project as below. Reuse the built images and set the dependency check to warn in the local resetter.

```powershell
$override = 'test-results/verify-relay-crm/compose.local.yaml'
New-Item -ItemType Directory -Force (Split-Path $override) | Out-Null
@'
services:
  resetter:
    environment:
      pnpm_config_verify_deps_before_run: warn
'@ | Set-Content $override
$env:COMPOSE_FILE = "compose.yaml$([IO.Path]::PathSeparator)$override"
docker compose up -d --wait --no-build
```

Repeat the readiness checks and keep `COMPOSE_FILE` set through cleanup.

With the pinned workspace dependencies installed, use `pnpm demo:check <directory>` in place of `docker compose up` for an automated run. The command requires an evidence directory outside the checkout and manages its own startup and cleanup. Add `--browser` to run the published browser journeys in Chromium. Use `--cold` and the builder instructions when measuring the first run. [Demo check](../../../docs/demo.md#first-run-measurements)

## Role journeys

Follow the controls in [Three things to try](../../../README.md#three-things-to-try). Use the role switcher to change roles after sign-in.

| Role                                                 | Journey                                                                                                                    | Evidence                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Priya Raman, manager                                 | Lead pool. Preview and confirm a round-robin assignment of two leads.                                                      | Preview names the owners, confirmation reports two assignments, and the leads leave the pool.               |
| Dele Akinwale, agent                                 | Queue. Open Hye-jin Park, log a **Spoke to them** attempt with a distinct note, then close as won if verifying conversion. | **Attempt saved** and the note in the timeline after reload. For conversion, **An account was opened**.     |
| Dele Akinwale, agent, then Esther Okafor, accountant | Open Leila Farouk's account, make the sandbox card payment with **Drop it**, then open the payment as accountant.          | **Credited once**, **The reconciler**, and one ledger posting. Check Mailpit if verifying receipt delivery. |

## Run the checks

Use the [development commands](../../../docs/development.md#commands) and the [CI integration and browser setup](../../../.github/workflows/ci.yml). Install the pinned workspace dependencies and run `pnpm db:generate` before host-side checks. For database checks, use a separate disposable PostgreSQL 17 server with the two roles from the development guide. If you start that server in Docker, give it a unique container name and a free loopback port. Set both database URLs to that server before testing.

- Run `pnpm test:int` for store and API behavior.
- Run `pnpm exec playwright install chromium` if Chromium is absent. To check the built-app suite, set `RELAY_EVIDENCE_DIR` to the worktree's evidence directory, then run `pnpm build` followed by `pnpm test:browser`.
- To prove the queue test catches a broken rule, start with a clean `packages/store/src/work.ts` in your own worktree. Run `pnpm test:mutations test-results/verify-relay-crm/queue work-note-attempt`. Keep the failing assertion, the restored pass, and `results.json`. Confirm `git diff --exit-code HEAD -- packages/store/src/work.ts` passes.

Run database checks one at a time. They rebuild the same template database. The mutation runner temporarily rewrites source.

## Save evidence and clean up

Keep screenshots, test output, and exit statuses under `test-results/verify-relay-crm/`. Capture each action and its visible result. Keep the automated demo output in the directory passed to `demo:check`.

For a manually launched demo, run `docker compose down --volumes` with the same project settings, even after a failed check. After either demo path, verify that `docker compose ps -a -q` prints no container IDs. Apply the same cleanup to any separate test Compose project you started. For a standalone test database container, stop and remove it by its exact name and confirm it is gone. Keep the evidence.
