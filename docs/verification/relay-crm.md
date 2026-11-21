# Relay CRM verification evidence

Local runs on 21 November 2026 on Docker Desktop for Windows, from the `chore/verify-relay-crm` worktree. The [verification skill](../../.agents/skills/verify-relay-crm/SKILL.md) has the commands. Every Compose command typed by hand named its project with `-p`. `pnpm demo:check` named it through `COMPOSE_PROJECT_NAME` until [the demo check needed a project name](#the-demo-check-needs-a-project-name).

## The resetter failed on a warm build cache

At base `0e6ac82`, `docker compose -p relay-fixrepro-base up -d --wait` reused the cached `pnpm install` layer. The resetter exited and the app stayed unhealthy.

```text
cmd: 'pnpm db:migrate',
"[EACCES] EACCES: permission denied, open '/app/_tmp_44_e10222ca2ad4ffea506c5e0eefc286cc'\n"
'[ERROR] Command failed with exit code 243: pnpm install\n'
dependency failed to start: container relay-fixrepro-base-app-1 is unhealthy
```

The maintenance image runs as `node` over a root-owned `/app`. Before `pnpm db:migrate`, pnpm compares the lockfile's time with the time of the last install. The image stores whole-second times, and pnpm counts a whole-second time as up to one second later. A lockfile written in the same second as the install then reads as modified, pnpm tries to rewrite its state under `node_modules`, and the write fails. With the check set to `error`, pnpm names the file.

```text
[ERR_PNPM_VERIFY_DEPS_BEFORE_RUN] EACCES: permission denied, open '/app/node_modules/.pnpm-workspace-state-v1.json.404895974'
```

Whether the times collide depends on the build cache, so CI's `demo` job passes while a local rebuild can fail. The resetter now runs `prisma migrate deploy` directly, without pnpm, and `pnpm test:image` runs it with stale manifest times and no network.

```text
Maintenance reached the database connection with a stale dependency status and no network.
```

## Demo check

With the fix, `pnpm demo:check <directory> --cold` passed for project `relay-fixcold-7c41e2` on the same warm cache. It signed in all three roles, paid one checkout through the webhook, recovered a second through the reconciler, read the receipt and reset the demo.

```text
QUICKSTART {"wallMs":29234,"command":"docker compose up","roles":["Priya Raman","Dele Akinwale","Esther Okafor"], ...}
LIVE_RECOVERY {"paymentId":"01a1fd68-a5f9-70ae-98f6-018505d6cc38","completedBy":"reconciler","wallMs":4159}
LIVE_RESET {"sessionsEnded":true,"visitorPaymentRemoved":true, ...}
```

## Role journeys

An earlier run on the same base drove two journeys by hand in a browser.

| Actor         | Action                                                                             | Observed result                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Priya Raman   | Previewed and confirmed a round-robin assignment of Luca Ferraro and Nadia Rahimi. | Preview showed Ffion Pryce for Luca and Noor Haddad for Nadia. The app said “2 leads were assigned.” Both leads left the pool.                                 |
| Dele Akinwale | Logged a **Spoke to them** attempt on Hye-jin Park.                                | The app said “Attempt saved. The lead is marked as contacted.” After reload the timeline still showed “Confirmed the evening class during local verification.” |

## Host checks

Each check ran on the host against a disposable PostgreSQL 17 container, one after another.

| Command                                                                     | Observed result                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm test:int`                                                             | 452 passed and 1 failed in 1,102 s. The failure was `P2028 Unable to start a transaction in the given time`.   |
| `pnpm test:mutations test-results/verify-relay-crm/queue work-note-attempt` | Baseline 35 passed, mutation 1 failed and 34 skipped, restored 35 passed. `work.ts` matched `HEAD` afterwards. |
| `pnpm build`, then `pnpm test:browser`                                      | 82 passed and 2 failed in 10.3 minutes, one on `P2028` and one on a 5-second heading wait.                     |
| The two failed browser files, rerun alone                                   | 25 passed.                                                                                                     |

The `P2028` failure was in `work.int.test.ts`, whose 35 tests all passed in the mutation baseline and restored runs. The mutation caught the broken rule at the queue assertion. [Test](../../packages/store/test/work.int.test.ts#L906)

```text
FAIL  |integration| packages/store/test/work.int.test.ts > a note does not count as an attempt in the queue
AssertionError: expected [] to deeply equal [ Array(1) ]
```

## The demo check needs a project name

`pnpm demo:check` read its project name from `docker compose config` and ran `config` and `up` without `-p`. Without `COMPOSE_PROJECT_NAME`, Compose fell back to the folder name, and the check's teardown used that name too. In the worktree that read:

```text
name chore-verify-relay-crm-5ef013c89a7677ea app image chore-verify-relay-crm-5ef013c89a7677ea-app:local
```

The check now refuses to start without the variable, with the folder's default name or with `relay-crm`, before it creates the evidence directory. It passes the name with `-p` to every Compose call, and CI's `demo` job sets `relay-ci-demo`.

```text
Error: Set COMPOSE_PROJECT_NAME to a fresh, disposable project name, such as relay-verify-1a2b3c4d. It must not be Compose's default for this folder (chore-verify-relay-crm-5ef013c89a7677ea) or relay-crm.
```

With `COMPOSE_PROJECT_NAME=relay-verify-644be7a7`, and again on the final code with `relay-verify-cd8172b6`, `pnpm demo:check <directory> --cold` passed. Each run left no containers, volumes, networks or images with its name. The final run shared the machine with the unit suite, so its `wallMs` is not a measurement. Its lines:

```text
QUICKSTART {"wallMs":387878,"command":"docker compose up","roles":["Priya Raman","Dele Akinwale","Esther Okafor"], ...}
LIVE_RECOVERY {"paymentId":"01a1fd95-bbae-72ca-804e-85efe1c72464","completedBy":"reconciler","wallMs":50502}
LIVE_RESET {"sessionsEnded":true,"visitorPaymentRemoved":true, ...}
exit 0
containers:[] volumes:[] images:[] networks:[]
```

## The migrate script needs Node 24.2

`packages/store/src/migrate.ts` deploys migrations only when `import.meta.main` is true. Node added `import.meta.main` in v24.2.0, so on 24.0 or 24.1 `pnpm db:migrate` would exit 0 without migrating. [Node.js ESM docs](https://nodejs.org/docs/latest-v24.x/api/esm.html#importmetamain) The Dockerfile pins 24.14.0 and CI installs the newest 24, so only a host on 24.0 or 24.1 was affected. The root `engines` field and the development and mobile pages now say 24.2 or later. pnpm warns on an unsupported Node and does not refuse. The web app's `24.x` stays, because Vercel reads it as the newest 24.

`packages/store/test/migrate.test.ts` runs the script without a database URL and expects Prisma's `migrate deploy` error. With the condition replaced by `undefined`, what Node 24.1 evaluates, the test failed. Restored, it passed.

```text
FAIL  |unit| packages/store/test/migrate.test.ts > running the migrate script runs prisma migrate deploy
AssertionError: promise resolved "{ stdout: '', stderr: '' }" instead of rejecting
Tests  1 passed (1)
```

## Cleanup

Both Compose projects and the test database container were removed by name. Label-filtered container, volume and image listings for each name came back empty.
