# Relay CRM verification evidence

Local run on 21 November 2026 from the `chore/verify-relay-crm` worktree at base `0e6ac82`. The [verification skill](../../.agents/skills/verify-relay-crm/SKILL.md) has the commands. Full logs and screenshots are in the worktree's `test-results/verify-relay-crm/`.

## Demo journeys

Project `relay-verify-31a7d5e2` built the app from this worktree. On the first launch, the resetter exited when `pnpm db:migrate` tried to reinstall dependencies and hit `EACCES`. The app returned 503. After teardown, the skill's local override let the same image run migrations and seed fresh volumes. Compose reported a healthy app, and `GET /api/health` returned 200.

| Actor         | Action                                                                             | Observed result                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Priya Raman   | Previewed and confirmed a round-robin assignment of Luca Ferraro and Nadia Rahimi. | Preview showed Ffion Pryce for Luca and Noor Haddad for Nadia. The app said “2 leads were assigned.” Both leads left the pool.                                 |
| Dele Akinwale | Logged a **Spoke to them** attempt on Hye-jin Park.                                | The app said “Attempt saved. The lead is marked as contacted.” After reload the timeline still showed “Confirmed the evening class during local verification.” |

Read `role-proof.log`, `manager-preview.png`, `manager-assigned.png`, `agent-attempt.png`, and `agent-reloaded.png` for the browser proof. Read `resetter-first.log` and `compose-retry-up.log` for startup.

## Queue mutation

`pnpm test:mutations test-results/verify-relay-crm/queue work-note-attempt` ran against a separate disposable PostgreSQL instance. The runner used a local image whose 116 store, domain, and test configuration inputs matched the worktree byte for byte. The worktree's `packages/store/src/work.ts` was mounted into the runner so the temporary edit stayed in this checkout.

The mutation let a note count as a call attempt. The standard integration test failed at the queue assertion. [Test](../../packages/store/test/work.int.test.ts#L906)

```text
FAIL  |integration| packages/store/test/work.int.test.ts > a note does not count as an attempt in the queue
AssertionError: expected [] to deeply equal [ Array(1) ]
```

| Run      | Observed result                                                                        |
| -------- | -------------------------------------------------------------------------------------- |
| Baseline | 35 passed                                                                              |
| Mutation | 1 failed, 34 skipped. The lead left `notYetCalled`.                                    |
| Restored | 35 passed. The mutation runner exited 0 and the source hash matched the starting hash. |

The assertion is in `queue/work-note-attempt.log`. The other runs are in `queue/baseline.log` and `queue/restored.log`. See `queue/results.json` for exit statuses.

## Cleanup

`docker compose down --volumes` removed both disposable projects. The Compose container listings were empty, and a name-filtered listing confirmed zero containers from this run. See `compose-down.log` and `queue-db-down.log`.
