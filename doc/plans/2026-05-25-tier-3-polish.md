# Tier 3 polish — which items to pull forward

**Status:** Planning · prioritization document
**Source:** Gap analysis at `~/.claude/plans/playful-gathering-firefly.md`
"Recommended next moves" Tier 3, plus the still-deferred MCP items.
**Sibling decision:** Tier 2 is deferred — see
`doc/plans/2026-05-25-tier-2-deferral.md`.

## Context

Tier 1 #1 (pricing + gate) is shipped (`9df115ae`, `cc95e013`).
Tier 1 #2 (workflow stages) and #3 (skill analyzer) are planned for
later sessions.
Tier 2 (content orchestration) is explicitly not happening.

That leaves Tier 3 polish items plus a handful of MCP work items still
deferred from earlier in the session. This document picks the right
next ~2-3 commits' worth of work and points the way to the rest.

## The candidate list

From the original gap analysis Tier 3:

- **(T3-A) Runtime Zod validation on plugin tool I/O.** Plugin tools
  declare `parametersSchema` as a `Record<string, unknown>` (JSON
  Schema string), but inputs are not validated before dispatch.
  ~3 days. Catches a real but low-frequency footgun.

- **(T3-B) Mid-execution cancellation signal** propagated through
  long-running tool calls. Today `fork.kill` is sent but in-flight HTTP
  isn't always cancelled. ~1 week. Mostly matters when long calls
  exist; less urgent without media generation.

- **(T3-C) Typed termination contracts per task type** (per-stage Zod
  schemas on `resultJson`). ~3 days. Cheap, and pairs naturally with
  Tier 1 #2 if that lands first.

- **(T3-D) Horizontal scale on heartbeat runtime** (Inngest / Hatchet
  migration). Large; only worth it when single-process throughput is
  the bottleneck. Sketched in an earlier session plan. **Deferred —
  not in this round.**

From still-deferred MCP work (earlier this session):

- **(M-A) Authorization Code (PKCE) flow + signed_jwt auth** for
  upstream MCP servers. Currently both throw "unsupported." Multi-hour
  browser-redirect work; new callback route; new instance-settings.
  Only matters when an enterprise upstream requires interactive auth.
  ~1-2 weeks.

- **(M-B) Last-Event-ID replay / resumability** on the gateway SSE
  stream. On reconnect the agent misses any events emitted while
  disconnected. Needs per-session circular event buffer keyed by event
  id. ~3 days. Matters mostly for long-running tool calls — see T3-B.

- **(M-C) Non-progress notification fan-out** (notifications/message,
  list_changed) from upstream MCP servers via the shared client's
  fallback handler. ~2 days. Low immediate value — almost no
  upstream emits these today.

- **(M-D) `openclaw-gateway` adapter MCP wiring.** Needs upstream
  research before scoping. ~1-2 weeks once research is done.
  **Deferred — not in this round.**

## Recommended sequencing

Given the no-pivot decision, three commits in priority order:

### Commit 1 (priority high) — T3-A: Runtime Zod validation on plugin tool I/O

**Why first:** Smallest scope (~3 days), real but currently-rare
footgun, no dependencies. Plugin tool inputs come from agent CLIs over
JSON-RPC; today a malformed payload reaches the plugin worker and is
its problem to handle. Centralizing validation means consistent error
shape, structured rejections in `plugin_logs`, and one less per-plugin
concern.

**Files (high level):**

- `server/src/services/plugin-tool-dispatcher.ts` — add a Zod-from-JSON-
  Schema validator step between auth check and dispatch.
- `packages/shared/src/validators/plugin-tool-input.ts` (new) — a thin
  wrapper over a JSON-Schema-to-Zod conversion. Use the
  `json-schema-to-zod` package or hand-roll a converter limited to the
  subset of JSON Schema actually used in plugin manifests (object,
  string, number, boolean, array, enum, required). Hand-rolled is
  acceptable here — plugin manifests don't use exotic JSON Schema
  features.
- `server/src/__tests__/plugin-tool-dispatcher-validation.test.ts`
  (new) — 6-8 tests covering type mismatch, missing required field,
  enum violation, extra unexpected field (we should accept, not reject,
  for forward-compat).

**Tests required:** input rejected with structured 400 error including
the field path; rejection writes a `plugin_logs` row; valid input still
dispatches normally; older plugins with no `parametersSchema` are
silently skipped (don't break old plugins).

**Risk:** if the validator is stricter than the plugin author expected,
plugins start rejecting calls they used to accept. Mitigation: opt-in
via a manifest flag `strictValidation: true`. Default `false` until
plugins have a chance to adapt. Add the flag to
`packages/plugins/sdk/src/manifest.ts`.

**Estimated effort:** 2-3 days.

### Commit 2 (priority medium) — T3-C: Typed termination contracts

**Why second:** Pairs cleanly with the workflow-stages plan
(`2026-05-25-workflow-stages-within-runs.md`). Even without stages, a
per-task-type Zod schema for `heartbeat_runs.resultJson` adds value:
adapters that return malformed termination payloads fail loudly rather
than silently writing garbage into the durable run state.

**Files (high level):**

- `packages/shared/src/validators/run-result.ts` (new) — a discriminated
  union keyed by `kind` (`code_task` | `mcp_tool_call_chain` |
  `routine_trigger` | etc.). Each branch declares the required shape
  of `resultJson`.
- `server/src/services/heartbeat.ts` — at run finalization, before
  setting `status='succeeded'`, validate `resultJson` against the
  schema for the run's `kind`. On failure, transition to `failed` with
  `errorClass='malformed_result'`.
- Tests: 4-6 cases per task kind; one canary test confirming a known
  good run still succeeds.

**Dependency:** ideally lands after Tier 1 #2 stages so each *stage*
can also carry its own typed output. But the run-level version is
independently shippable today.

**Risk:** if a currently-shipping adapter emits a `resultJson` shape
that doesn't match the new schema, that adapter's runs start failing.
Run the full server suite + manual smoke before flipping the new
validation on. Mitigation: `PAPERCLIP_RESULT_VALIDATION_ENABLED`
(default `false`) for a soft rollout.

**Estimated effort:** 2-3 days.

### Commit 3 (priority medium) — M-B: SSE Last-Event-ID replay

**Why third:** Pairs naturally with T3-B (mid-execution cancellation)
because both deal with long-running upstream calls. But Last-Event-ID
replay is much smaller scope and ships value standalone — agents that
disconnect mid-tool-call currently lose progress events; they would
keep them after this commit.

**Files (high level):**

- `server/src/services/mcp/sessions.ts` — add a per-session circular
  buffer of (eventId → frame) pairs. Cap at 1000 events per session;
  evict oldest.
- `server/src/routes/mcp-gateway.ts` GET handler — on connect, read
  the `Last-Event-ID` request header; if set and matches a buffered
  event, replay every event since that id before resuming live
  fan-in. If no match (gap too large), respond with a comment line
  `:gap` and proceed with live-only.
- `server/src/__tests__/mcp-gateway-sse.test.ts` — extend with 3 new
  tests: replay with valid Last-Event-ID, replay with stale id (gap
  notice), buffer overflow eviction.

**Risk:** memory. 1000 events × ~1KB each × N concurrent sessions per
company × M companies = real RSS impact. Mitigation: per-session cap
already proposed; instance-wide cap via env var
`PAPERCLIP_MCP_SSE_REPLAY_BUFFER_SIZE` (default 1000).

**Estimated effort:** 2-3 days.

## Items not in this round

- **T3-B (mid-execution cancellation)** — touches every adapter's tool
  call path. Worth doing, but the right time is when a long-call
  workload exists. Not a current pain point. Document in the gap
  analysis as still-deferred.

- **T3-D (Inngest/Hatchet migration)** — multi-week refactor, no
  current throughput bottleneck. Not now.

- **M-A (PKCE + signed_jwt)** — needed only when an enterprise upstream
  MCP server requires it. No such requirement today. Document the
  TODO in `client-pool.ts` to point at this file when the time comes.

- **M-C (non-progress notification fan-out)** — almost no upstream
  emits these today. Worth ~2 days when a real upstream demands it.

- **M-D (openclaw-gateway MCP wiring)** — needs upstream research
  first.

## What this delivers

Three small commits, ~7-10 days of focused engineering total. Each
ships independently and has its own feature flag so a misfire is easy
to roll back without a revert. After all three, Paperclip's runtime
is meaningfully tighter:

- Plugin tool inputs are typed all the way through.
- Run termination is contract-checked.
- Agent CLIs survive disconnect mid-call without losing events.

None of this is product-pivoting; all of it is polish that pays for
itself in operational incidents avoided.

## Verification path (per commit)

Each commit follows the standard sequence:

1. `pnpm --filter @paperclipai/db build`
2. `pnpm --filter @paperclipai/shared build`
3. `pnpm --filter @paperclipai/db run check:migrations` (only if any
   migration lands — none of these three commits adds a migration).
4. `pnpm -r typecheck`
5. Targeted vitest run for the new tests.
6. Full server suite (1930+/1931+ pass with the same one
   `heartbeat-comment-wake-batching` flake acceptable).
7. UI suite if touched.

## Out of scope for this prioritization

- The mid-execution cancellation effort (T3-B). See "Items not in this
  round."
- Any UI work. None of T3-A, T3-C, M-B touches the UI; their value is
  entirely in the runtime.
- New tests for adapters whose `parametersSchema` happens to be empty.
  T3-A's validator is a no-op for those — leave them alone.

## Pointers to source material

- Original gap analysis: `~/.claude/plans/playful-gathering-firefly.md`
  ("Recommended next moves" section, Tier 3 list).
- Plugin tool dispatcher: `server/src/services/plugin-tool-dispatcher.ts`
  + `server/src/services/plugin-tool-registry.ts:69` declares the
  `parametersSchema` field shape.
- Heartbeat finalization: `server/src/services/heartbeat.ts::executeRun`
  finalization branch.
- MCP gateway SSE handler: `server/src/routes/mcp-gateway.ts` GET +
  `server/src/services/mcp/sessions.ts` (~175 LOC) introduced in
  commit `a4fc999d`. The TODO about resumability is at the top of
  `mcp-gateway.ts`.
