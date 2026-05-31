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

## RESOLVED — true root cause is a brittle test assertion (2026-05-31, third pass)

**FIXED. The bug is a too-strict test assertion, NOT a runtime defect.**
The second-pass hypothesis below ("promoted run never finalizes / adapter
hang") was ALSO wrong — production instrumentation disproved it. Keeping
the full trail because each wrong turn was disproved by evidence, and that
record is the point.

Production-path instrumentation (`runtimeMark` in heartbeat.ts at
`executeRun` enter/claim/return, around `adapter.execute`, at
`run.finalize`, and in `startNextQueuedRunForAgent`) plus a per-poll
`assert.runs` dump captured the failing run under CPU load. The timeline
is unambiguous:

- The test's own agent ends with **THREE** terminal runs, not two:
  the cancelled original, the promoted follow-up (`succeeded`), and an
  ADDITIONAL benign promoted run that wakes, finds no pending work, and
  finalizes `succeeded` WITHOUT sending a gateway payload.
- **Every run reaches a terminal status in ~120ms.** `adapter.execute.exit`
  and `run.finalized` fire for all of them. The runtime is correct and
  fast — nothing hangs, nothing is lost.
- The failing assertion was:
  `runs.length === 2 && runs.every(r => ["cancelled","succeeded"])`.
  The `runs.length === 2` clause is the bug: the cancel-while-promote
  interleaving can legitimately produce a third run. When timing places
  the check before the 3rd run is created, it passes; when the 3rd run
  materialises, the count is permanently 3 and the 90s `waitFor` never
  satisfies `=== 2`. That is the entire flake.

### The fix

Assert on the SPECIFIC runs the test is about, not the total count
(matching the sibling test at ~line 540 which already does this):

```ts
const promotedRunId = typeof promotedPayload.idempotencyKey === "string"
  ? promotedPayload.idempotencyKey : null; // throw if missing
await waitFor(async () => {
  const runs = await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.agentId, agentId));
  const statusByRunId = new Map(runs.map((r) => [r.id, r.status]));
  return statusByRunId.get(firstRun!.id) === "cancelled"
      && statusByRunId.get(promotedRunId) === "succeeded";
}, 90_000);
```

### Verification

Reproduced the failure under 2-3× CPU load (failed at iteration 3 of a
loaded loop, pre-fix). Post-fix: **30/30 green under 3× CPU load**, plus
9/9 with the harness off, plus 82/82 across the promotion/scheduling
heartbeat suites (no regression from the production instrumentation). The
`runtimeMark` calls are env-gated (`PAPERCLIP_FLAKE_TRACE`) and return
before any allocation when disabled — zero production cost.

### Note on the "third run"

Whether emitting a second (no-op) promoted run on the cancel-while-promote
path is ideal runtime behaviour is a separate, lower-priority question. It
is benign (wakes, no work, clean `succeeded`, no gateway payload, correct
activity/cost accounting) and is NOT a correctness bug in the control
plane. If it is ever deemed wasteful, the fix is in promotion dedup, not
this test. Filed here as an observation, not a defect.

---

## (Superseded) Second pass — runtime finalization hypothesis (DISPROVEN)

Kept for the record; the third pass above is the correct conclusion.

### Residual — ROOT CAUSE FOUND via tracing harness (2026-05-31, second pass)

**The earlier hypotheses in this section were WRONG and are corrected
below. The residual is a real runtime finalization bug, NOT a
test-isolation defect and NOT connection starvation.**

A causal tracing harness was built (`server/src/__tests__/helpers/flake-trace.ts`,
env-gated by `PAPERCLIP_FLAKE_TRACE`) combining (1) `async_hooks` span
propagation, (2) `perf_hooks.monitorEventLoopDelay`, and (3) per-query
enqueue→resolve timing with in-flight counts. It dumps the timeline only
when a test fails. Run in a loop, it captured the failure on iteration 2-3
each time. The captured trace of
`"promotes deferred comment wakes with their comments after the active run
is cancelled"` is decisive:

- **Event loop is FLAT** during the 90s hang: p99 ≈ 11.4ms, max ≈ 19-23ms
  (histogram-resolution noise). NOT loop-bound — nothing is hogging the
  loop. This *disproves* "loop-bound blocking".
- **In-flight queries never exceed 1**; every query resolves in <1.5ms.
  This *disproves* connection-pool starvation outright. (The `max:1`
  starvation theory was already known wrong; this also kills the weaker
  "contention" theory.)
- **The test's `waitFor` poll loop ran the entire 90s** — 1743 polls,
  every one `met:false`. The loop never froze; instrumented `waitFor.poll`
  heartbeats fire every ~2s right up to `waitFor.timeout` at 90s. So the
  condition (both runs in `cancelled|succeeded`) was *simply, permanently
  false*. The promoted run never went terminal.
- **All three `agent.wait`s were answered `ok`**: run #1 (the cancelled
  run, gated then released) and runs #2/#3 (the promoted follow-ups) each
  received an `ok` wait response from the mock gateway. The
  `gateway.agent.dispatch` + `gateway.agent.wait.respond` markers confirm
  the full WS handshake completed for all three.
- **After the last finalize-adjacent query (~2.0s into the test), the
  heartbeat runtime issues ZERO further DB queries for 90s** — no claim
  CAS, no event append, no terminal-status write for the promoted runs.
  The runtime goes completely silent.
- **Smoking gun:** the instant the test times out and its `finally` runs
  `releaseFirstWait()` + `waitForAgentQuiescence`, the next poll returns
  `met:true` *immediately* — i.e. quiescence reports the runs ARE terminal
  the moment we stop waiting on the gated path. The state the assertion
  wanted does materialise, just not on the path/time the test observes.

**Conclusion:** `adapter.execute` (or `executeRun`'s finalize) for a
*promoted* run does not drive the run to a terminal status on the
interleaving where run #1 is cancelled while runs #2/#3 are promoted. The
gateway handshake (`agent` + `agent.wait` → `ok`) completes, but the
finalization that writes `status=succeeded` (heartbeat.ts ~8269/8352-8393)
never happens — the run's `await adapter.execute(...)` appears to stay
pending, or `executeRun` for the promoted run never reaches its finalize
block. This aligns with the runId-alignment fragility noted below (why the
runId-keyed gate regressed): the cancel of run #1 and the wait-response
routing for the promoted runs are keyed on `runId` in a way that drops the
promoted run's terminal transition under this ordering.

### Confirmed-eliminated hypotheses (with the disproving evidence)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Loop-bound blocking | DISPROVEN | event-loop p99 ≈ 11ms, flat, during the hang |
| Connection-pool starvation | DISPROVEN | in-flight queries ≤ 1; all resolve <1.5ms |
| `waitFor` loop froze / starved | DISPROVEN | 1743 polls ran across the full 90s |
| Cross-test orphaned-run bleed (residual) | NOT the residual | the victim test's OWN promoted runs never finalize, within its own window |
| Promotion too slow | DISPROVEN (prior) | promotion enqueue/dispatch is single-digit ms |

### Next step (now narrow and runtime-side, not "interactive debugging")

Instrument the PRODUCTION path with the same harness `mark()` calls,
env-gated, for ONE captured failure:

1. At `executeRun` entry: `mark("executeRun.enter", { runId, invocationSource })`.
2. Around `await adapter.execute(...)`: `mark("adapter.execute.enter/exit", { runId })`.
3. At the finalize/terminal write (~8269, ~8392): `mark("run.finalize", { runId, outcome })`.

The single question that decides the fix: for the promoted run, does
`adapter.execute.exit` ever fire?
- **If NO** → `adapter.execute` is hung after `agent.wait` returns `ok`;
  the bug is in the adapter client's wait-response routing (the `ok`
  reaches the socket but is not delivered to the awaiting `execute` call,
  likely a `runId` keying mismatch when a sibling run was cancelled). Fix
  in the adapter client / wait-response dispatch.
- **If YES but no `run.finalize`** → `executeRun`'s post-execute path
  early-returns or throws silently for promoted runs; fix in heartbeat
  finalize.

Do NOT touch the mock's wait gate (tried, regressed — see below). The bug
is now known to be runtime-side, not in the test's gating.

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
