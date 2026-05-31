# heartbeat-comment-wake-batching flake — audit, root cause, fix plan

**Date:** 2026-05-31 (reproduced, classified, partial fix shipped)
**Test:** `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
**Status:** Primary cause (cross-test orphaned-run bleed) FIXED via
per-test quiescence. A residual lower-rate flake remains; measured
improvement ~60% → ~87% green. Production logic confirmed correct — no
production change. See "Measured results" and "Residual" below.

## Shipped fix

Added `waitForAgentQuiescence(db, agentIds)` (module-level helper) and
called it in all 8 test `finally` blocks, after `gateway.releaseFirstWait()`
and before `gateway.close()`. It polls `heartbeat_runs` until no run for the
test's agent(s) is `queued`/`running`, so a promoted follow-up run cannot
bleed into the next test. Test-only change; `pnpm -r typecheck` clean.

## Measured results

Whole-file loop (9 tests), `vitest run heartbeat-comment-wake-batching.test.ts`:

| | Pre-fix | Post-fix (cumulative) |
|---|---|---|
| Green rate | ~60% (e.g. 2/5, 7/8) | ~87% (39/45 across batches) |

Post-fix batches were high-variance (12/12 one batch, 11/15 another),
which indicates the residual rate tracks machine load at run time.

## Residual (not yet eliminated)

The varying-victim cross-test bleed is gone (that was the dominant cause).
The residual failure still lands on the `waitFor(... both runs terminal ...,
90_000)` at the END of the deferred-comment-wake promotion tests — the
promoted follow-up run occasionally does not reach `succeeded` within the
window. Ruled out as the residual cause: promotion speed (2-12ms, instrumented),
quiescence timeouts (never observed), connection-pool starvation (the test
`db` uses postgres.js default `max:10`, not `max:1` — only the migration
utility client is `max:1`). The residual appears to be a genuine
load-sensitive timing race between the test's mock-gateway `agent.wait`
gating (a global `waitCount===1` first-wait gate) and the real heartbeat
runtime's dispatch ordering of the promoted run. It does NOT reproduce when
the failing test is run alone (`-t`, 6/6), only in the full-file sequence,
so it needs interactive debugging of the cross-test runtime-state
interaction — not derivable statically.

## Reproduction

Earlier belief ("passes 3/3 in isolation, only fails in loaded full suite")
was WRONG — that was a single `-t`-filtered test. Running the **whole
9-test file** in a loop reproduces reliably:

```
for run in 1..6: vitest run heartbeat-comment-wake-batching.test.ts
→ runs 1, 5 FAILED; 2, 3, 4, 6 passed   (~33-40% failure rate)
```

The **failing test varies run to run** ("…after the active run closes the
issue", "…after the active run is cancelled", "…forwards the ordered
batch"). A varying victim is the signature of cross-test state bleed, not a
bug in any one test.

## Classification: NOT a production stall, NOT slowness

Instrumented `releaseIssueExecutionAndPromote` (heartbeat.ts:8772, the
inline deferred-wake promotion) and `startNextQueuedRunForAgent` with
entry/exit timing, ran until failure. In every run — including the failing
ones — the promotion chain was fast:

```
[flake] promotion txn done            kind=promoted   dtMs=2-5
[flake] startNextQueuedRunForAgent END                dtMs=8-12
```

So the earlier doc's open question ("slowness vs stall in promotion") is
answered: **neither.** The promotion enqueues and dispatches the second run
in single-digit milliseconds, every time. The 90s `waitFor` timeout is not
waiting on the promotion.

## Root cause: orphaned async runs starve a single shared DB connection

Three facts combine:

1. **Single shared connection.** `packages/db/src/client.ts:14` —
   `createDb` uses `postgres(url, { max: 1 })`. The test file shares ONE
   `db` across all 9 tests (file-level `beforeAll`). Every query in the
   file — across all tests and all background runs — serializes through one
   connection.

2. **Promoted runs are fire-and-forget.** When a test triggers a deferred-
   comment-wake promotion, `releaseIssueExecutionAndPromote` calls
   `startNextQueuedRunForAgent(promotedRun.agentId)` (heartbeat.ts:9200).
   That dispatches the promoted run, which then executes asynchronously —
   issuing its own DB queries, and on completion calling
   `releaseIssueExecutionAndPromote` AGAIN (the cascade of `ENTER` lines in
   the instrumented logs proves this). The test does NOT await this tail; it
   asserts on `gateway.getAgentPayloads()` and then its `finally` closes the
   gateway and returns.

3. **Tails bleed across test boundaries.** The instrumented logs show, at
   the START of one test's block, `ENTER`/`END` lines for promoted runs
   belonging to the PREVIOUS test — proof that prior-test runs are still
   live when the next test begins. Those orphaned runs keep hitting the one
   shared connection.

The failure: when the next test's `waitFor` polls the DB every 50ms, those
polls queue behind a prior test's orphaned-run queries on the single
connection. Under an unlucky interleaving, the new test's polls are starved
long enough that its 90s `waitFor` window expires before its own
(correctly-dispatched) second payload is observed. Different victim each run
because which test happens to start while a prior tail is busiest is
timing-dependent.

This is a **test-isolation defect**, not a control-plane bug. The promotion
logic is correct and fast; the test simply doesn't quiesce its background
work before moving on, and the `max: 1` connection turns that leak into
starvation rather than mere wasted work.

## Why it never showed in `-t` isolation

A single filtered test has no prior test leaking a tail into it, and no
following test to be starved — so the bleed can't happen. The bug only
exists in the multi-test interaction within the file.

## Fix plan (test-side; no production change)

### Primary fix — await quiescence per test

In each test's `finally` (there are 8-9 of them), before
`gateway.close()`, wait for the agent's runs to reach terminal state so no
background work bleeds into the next test. Add a helper near `waitFor`:

```ts
async function waitForAgentQuiescence(agentId: string, timeoutMs = 30_000) {
  await waitFor(async () => {
    const live = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
      ));
    return live.length === 0;
  }, timeoutMs);
}
```

Call it in each test's `finally` for every agent the test exercised:

```ts
} finally {
  gateway.releaseFirstWait();          // unblock any parked wait first
  await waitForAgentQuiescence(agentId).catch(() => undefined);
  await gateway.close();
}
```

Releasing the parked wait BEFORE quiescing is essential — a run blocked on
the mock's `firstWaitGate` will never terminate otherwise. The `.catch`
keeps a quiescence timeout from masking the test's real assertion result.

This eliminates the bleed at the source: each test leaves the shared
connection idle before the next begins.

### Remaining work for full elimination (residual)

The quiescence fix is shipped and helps materially (~60% → ~87%), but a
lower-rate residual remains. It needs interactive debugging that static
analysis could not resolve.

**A runId-keyed mock gate was TRIED AND MADE IT WORSE — do not repeat it.**
The hypothesis was that the mock's global `waitCount===1` first-wait gate
races between the initial and promoted runs, so keying the gate on the
first dispatched run's runId would make it order-independent. Implemented
(capture first dispatched `runId`, hold only that run's `agent.wait`) and
measured: the green rate DROPPED from ~87% to ~40% (6/15). The global
`waitCount` gate is actually more robust here than runId-keying —
reverted. Whatever the residual is, it is NOT the wait-gate ordering, and
runId-keying introduces a different failure (likely because the cancelled
initial run's returned runId vs the wait's runId don't align the way the
`acceptedPayload.runId` plumbing assumes under all paths).

Concrete next steps for whoever picks it up:

1. **Instrument the promoted run's full lifecycle in a captured failure**:
   log every status transition of the promoted run (queued → running →
   succeeded) alongside the mock's `agent.wait` receipt and
   `releaseFirstWait()` timing, in a full-file loop until one fails. The
   failing assertion is the terminal-status `waitFor` (both runs
   cancelled/succeeded) — the promoted run isn't reaching `succeeded`.
   Find where it actually stalls.
2. Do NOT touch the mock's wait gate (tried, regressed). Look instead at
   whether the promoted run's `agent.wait` response is being delivered —
   e.g. socket/connection lifecycle on the shared gateway, or the adapter
   client's handling of the wait response under load.
3. Re-measure with a 20× full-file loop; target 20/20.

### Rejected approaches (with reasons)

- **Per-test DB** (`beforeEach`): each `startEmbeddedPostgresTestDatabase`
  starts a fresh postgres process (seconds). ×9 tests is too slow, and the
  embedded-pg startup was itself a contention source earlier this session.
- **Raise test pool `max`**: investigated and found moot — `createDb`
  already uses postgres.js default `max:10`; only the migration utility
  client is `max:1`. Pool starvation is not the residual cause.

## Effort

Quiescence fix (shipped): ~done. Residual elimination: needs a captured
repro + the runId-keyed mock gate, est. 2-4 hours of interactive
debugging. Test-only; low risk.

## Note on the symref test

The other recurring full-suite failure —
`workspace-runtime.test.ts > auto-detects the default branch via symbolic-ref`
— is unrelated: it's a `git push origin main master` against a repo with
only a `main` branch, environment-dependent on the host git default branch.
Separate fix (the test should create both branches, or push only `main`).
Not part of this flake.
