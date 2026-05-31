# heartbeat-comment-wake-batching flake — root-cause analysis

**Date:** 2026-05-31
**Status:** Investigated; fix deliberately NOT applied (see "Decision").
**Test:** `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
Failing cases observed across sessions:
- "promotes deferred comment wakes after the active run closes the issue"
- "batches deferred comment wakes and forwards the ordered batch to the next run"
- "promotes deferred comment wakes with their comments after the active run is cancelled"

## Symptom

Intermittent `waitFor` timeout (the failing `waitFor` is already at 90s)
— `gateway.getAgentPayloads().length >= 2` never becomes true in the
failing run. Exit is a hard timeout, not an assertion mismatch.

## What was ruled out

1. **Not a production logic bug.** Run in isolation, the failing test
   passes 3/3 consecutively (`vitest run -t "promotes deferred comment
   wakes after the active run closes the issue"`). The promotion path
   (`releaseIssueExecutionAndPromote` in heartbeat.ts:8772, which runs the
   deferred-wake promotion transaction inline when a run completes) is
   correct.

2. **Not parallel cross-file contention.** `server/vitest.config.ts` sets
   `pool: "forks"`, `maxForks: 1`, `maxConcurrency: 1` — the server suite
   runs serially, one file at a time. No two test files share an embedded
   postgres or compete for connections concurrently.

3. **Not a background-timer leak.** `heartbeatService(db)` does not start
   any `setInterval`/`setTimeout` on construction — the scheduler loops
   live in `server/src/index.ts`, not the service. The 9 tests in the file
   each construct a fresh `heartbeatService(db)` with no background pumps.
   Promotion is inline-on-completion, not tick-driven.

4. **Not a timeout-too-short issue per se.** 90s is already enormous for
   this operation; isolated runs complete in low single-digit seconds.

## Root cause (narrowed, not fully confirmed)

The failing `waitFor` is `gateway.getAgentPayloads().length >= 2`. The
second payload is pushed when the **`agent` dispatch frame** for the
promoted run #2 arrives (mock lines 81-101) — this happens at dispatch,
BEFORE run #2's `agent.wait`. So a timeout on `length >= 2` means **run #2
is never dispatched within the window**, i.e. the inline deferred-wake
promotion (`releaseIssueExecutionAndPromote`, heartbeat.ts:8772) did not
enqueue+dispatch the second run in time.

The promotion runs inline when run #1 completes, inside a DB transaction
that selects the `deferred_issue_execution` wakeup, reopens the issue, and
enqueues the promoted run. In isolation this completes in well under a
second. The flake manifests only late in a long serial suite (the file runs
~250 files in, where embedded-postgres IO latency and GC pressure peak),
which is consistent with the whole completion→promotion→dispatch chain
occasionally drifting past even the 90s budget OR an intermittent stall in
that chain under load.

What I could NOT determine without a live reproduction (it passes 3/3 in
isolation and I have no way to force the loaded-suite condition on demand):
whether this is pure slowness (chain eventually completes, just past 90s)
or a genuine intermittent stall (chain wedges and never completes). Those
have different fixes and I will not guess between them.

This is most likely a **heavyweight-integration-test timing sensitivity**
rather than a control-plane logic bug — the promotion path is correct in
isolation — but I cannot rule out a load-triggered stall in the inline
promotion transaction.

## Decision: do not ship a speculative fix this session

I could not reproduce the failure on demand (3/3 isolated passes; the
loaded-suite condition that triggers it is not forceable), and I could not
distinguish "pure slowness past 90s" from "intermittent stall in the inline
promotion." Those need different fixes:

- If pure slowness: the fix is to make the test drive the
  completion→promotion→dispatch chain deterministically (e.g. await the
  promotion explicitly) rather than poll a wall-clock window — a
  test-only change.
- If a load-triggered stall: the fix is in the promotion path itself, and
  a test change would mask a real bug.

Shipping a change without knowing which would risk masking a genuine
control-plane stall. That violates the "don't mask, don't guess" bar this
work has held to all session. So: documented, not patched.

## Recommended next step (for whoever picks this up with a repro)

1. **Get a reliable repro first.** Run the full server suite in a loaded
   loop (e.g. 5x back-to-back, or with `--no-file-parallelism` plus an
   artificial memory load) until it fails, OR add temputs/logging around
   `releaseIssueExecutionAndPromote` (heartbeat.ts:8772) to capture
   wall-clock timing of the promotion chain when it runs late in the suite.
2. **Classify**: instrument the chain to log "run#1 completed at T",
   "promotion tx started/committed at T", "run#2 dispatched at T". If the
   gaps are large-but-finite → slowness; if the promotion tx never
   commits → stall.
3. **If slowness**: have the test await the promotion deterministically.
   The mock's second payload is pushed at run #2's `agent` dispatch frame
   (mock lines 81-101) — the test could subscribe to a promotion-complete
   signal instead of polling `getAgentPayloads().length`.
4. **If stall**: investigate the inline promotion transaction for a
   lock/contention issue under load (it `SELECT`s + `UPDATE`s issues and
   agent_wakeup_requests in one tx).

No production code change should be made until step 2 classifies the
failure.

## Cross-reference

This flake has been present and noted in every session's full-suite run
preceding 2026-05-31. It is unrelated to the MCP gateway, skill analyzer,
pricing, workflow-stages, or adapter-cutover work shipped in those
sessions — confirmed by the isolated-pass result above.
EOF