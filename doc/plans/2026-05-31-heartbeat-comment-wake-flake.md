# heartbeat-comment-wake-batching flake — audit, root cause, fix plan

**Date:** 2026-05-31 (reproduced + classified; supersedes the earlier
"investigated, not classified" version of this doc)
**Test:** `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
**Status:** Root cause confirmed. Fix is test-side (not production). Plan below.

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

### Secondary hardening (defense in depth, optional)

- **Per-test DB.** Move `startEmbeddedPostgresTestDatabase` from
  `beforeAll` to `beforeEach` so each test gets its own connection +
  schema. Heavier (embedded-postgres start cost × 9) but removes the
  shared-connection coupling entirely. Prefer the quiescence fix unless it
  proves insufficient.
- **Raise `max` for tests.** Setting `postgres(url, { max: 4 })` in the
  test client would reduce starvation, but it masks the leak rather than
  fixing it and changes prod/test parity. Not recommended as the primary
  fix.

### Verification protocol

1. Apply the quiescence fix.
2. Run the file in a 10× loop:
   `for i in $(seq 1 10); do vitest run heartbeat-comment-wake-batching.test.ts; done`
   — expect 10/10 green (was ~60-67%).
3. Run the full server suite twice end-to-end — expect the
   `heartbeat-comment-wake-batching` failures gone, leaving only the
   `workspace-runtime` symref env test (separate issue).
4. No production file changes; `pnpm -r typecheck` unaffected.

## Estimated effort

~1-2 hours: add the helper, wire it into the 8-9 `finally` blocks, run the
10× loop to confirm. Test-only; low risk.

## Note on the symref test

The other recurring full-suite failure —
`workspace-runtime.test.ts > auto-detects the default branch via symbolic-ref`
— is unrelated: it's a `git push origin main master` against a repo with
only a `main` branch, environment-dependent on the host git default branch.
Separate fix (the test should create both branches, or push only `main`).
Not part of this flake.
