# First-class workflow stages within a run

**Status:** Planned · not started
**Tier 1 #2** of the gap analysis at `~/.claude/plans/playful-gathering-firefly.md`.
**Depends on:** nothing already shipped. Builds on the existing heartbeat
runtime (`server/src/services/heartbeat.ts`) and the structured event
log (`heartbeat_run_events`). Unlocks Tier 1 #3 (skill analyzer).

## Context — why this is needed

The gap analysis found Paperclip enforces only `queued → running → terminal`
on `heartbeat_runs`. Within `running`, the adapter freely runs arbitrary
work; there is **no concept of named stages** (plan → metadata → media →
draft). One narrow test exists in `heartbeat-retry-scheduling.test.ts`
for codex retry stages, but it does not generalize.

Concretely this blocks:

- Any "plan first, then execute" flow (Tier 1 #1 pricing gate is a
  half-step; full plan-emit requires a discrete planning stage).
- The skill analyzer (Tier 1 #3) — needs to run as a pre-stage and emit
  its output for the next stage to consume.
- Per-stage cost/duration metrics (today `cost_events.heartbeatRunId` is
  the finest granularity; we cannot say "the metadata stage cost $X,
  media cost $Y").
- Typed termination contracts per task type (per the gap analysis, `Implemented`
  for the mechanism but `Partial` for the contract — stages are the missing
  unit of typing).

The goal of this change is to make stages **first-class rows** so they
can be created, transitioned, queried, and tested independently of the
run's overall lifecycle, while preserving the existing run-level CAS and
reaper semantics.

## Non-goals

- Replacing the existing run-level state machine. Runs still go
  `queued → running → terminal`; stages live inside `running`.
- Cross-run stage dependencies (e.g. "stage X of run B blocks on stage Y
  of run A"). That's a workflow-engine concern (Inngest / Hatchet) and
  out of scope.
- Resumability of in-flight stages across process restarts. A stuck
  stage today is reaped at the run level via `reapOrphanedRuns`; that
  remains the recovery path. Adding a per-stage reaper is a follow-up.
- Auto-derived stages. Stages are explicit — the adapter (or its
  caller) emits `startStage("plan")`, etc. We do not infer stages from
  event types.

## Schema

### New table `heartbeat_run_stages`

```ts
// packages/db/src/schema/heartbeat_run_stages.ts

import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const heartbeatRunStages = pgTable(
  "heartbeat_run_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    /** Ordinal — 1-indexed, contiguous per run. */
    ordinal: integer("ordinal").notNull(),
    /** Stage name. Conventional values: 'plan' | 'skill_analysis' | 'metadata' |
     *  'media' | 'draft' | 'publish' | 'execute' (fallback for legacy single-stage runs). */
    name: text("name").notNull(),
    /** queued | running | succeeded | failed | skipped | cancelled */
    status: text("status").notNull().default("queued"),
    /** Optional structured input passed to the adapter for this stage. */
    inputJson: jsonb("input_json"),
    /** Optional structured output emitted by the adapter at stage completion. */
    outputJson: jsonb("output_json"),
    /** When a stage fails, the typed error class (e.g. 'timeout', 'upstream_5xx'). */
    errorClass: text("error_class"),
    plannedAt: timestamp("planned_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("heartbeat_run_stages_run_idx").on(table.runId),
    runOrdinalUq: uniqueIndex("heartbeat_run_stages_run_ordinal_uq").on(table.runId, table.ordinal),
    runStatusIdx: index("heartbeat_run_stages_run_status_idx").on(table.runId, table.status),
  }),
);
```

Idempotent migration (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
Number: whatever drizzle assigns next (was 0090 at time of writing).
Run `pnpm --filter @paperclipai/db run check:migrations` to confirm the
snapshot landed — that CI check exists since commit `7902e845`.

Re-export from `packages/db/src/schema/index.ts`.

### `cost_events` extension (small, optional)

Add `stageId: uuid("stage_id").references(() => heartbeatRunStages.id, { onDelete: "set null" })`
to `cost_events`. Nullable. Lets us attribute spend per stage without
forcing a backfill of historic rows.

## Service layer

`server/src/services/heartbeat-stages.ts` (new):

```ts
export function heartbeatStageService(db: Db) {
  return {
    list(runId: string): Promise<Stage[]>;
    get(stageId: string): Promise<Stage | null>;

    /**
     * Plan a stage at the next ordinal. Returns the planned stage row.
     * Throws if a stage with the same ordinal already exists.
     */
    plan(runId: string, name: string, inputJson?: unknown): Promise<Stage>;

    /**
     * Atomic CAS: queued → running. Returns null if the stage isn't queued
     * (someone else claimed it, the run was cancelled, etc.).
     */
    start(stageId: string): Promise<Stage | null>;

    /**
     * Atomic CAS: running → succeeded with output.
     */
    succeed(stageId: string, outputJson?: unknown): Promise<Stage | null>;

    /**
     * Atomic CAS: running → failed with errorClass.
     */
    fail(stageId: string, errorClass: string): Promise<Stage | null>;

    /**
     * Mark a queued stage as skipped (e.g. plan stage skipped when gate
     * is disabled, or skill_analysis skipped when no analyzer plugin
     * is installed).
     */
    skip(stageId: string, reason: string): Promise<Stage | null>;

    /**
     * Cascade-cancel: when a run transitions to cancelled, mark all
     * non-terminal stages as cancelled.
     */
    cancelAllForRun(runId: string): Promise<void>;
  };
}
```

Each mutation:
- Writes a corresponding event into `heartbeat_run_events` so the existing
  realtime fan-out (`publishLiveEvent`) keeps working. Event types:
  `stage.planned`, `stage.started`, `stage.succeeded`, `stage.failed`,
  `stage.skipped`, `stage.cancelled`.
- Updates the parent run's `updatedAt` for liveness reasons.

## Heartbeat integration

In `server/src/services/heartbeat.ts`:

1. **Default-stage backfill on claim.** When `claimQueuedRun` transitions
   a run from `queued → running` AND no stages exist for it, insert a
   single stage `(ordinal=1, name='execute', status='running', startedAt=now)`.
   This preserves backward compatibility — existing adapters that never
   call the stage API still get one synthetic stage covering their entire
   execution. The `succeeded`/`failed` transition at run finalization
   transitions that synthetic stage too.

2. **Stage-aware finalization.** When the runtime transitions a run to
   a terminal state, also transition any still-`running` stage to the
   matching terminal state. `cancelAllForRun` covers the `cancelled` case.

3. **Adapter API.** Extend `AdapterExecutionContext` in
   `packages/adapter-utils/src/types.ts` with:

   ```ts
   stages?: {
     plan: (name: string, inputJson?: unknown) => Promise<{ id: string }>;
     start: (stageId: string) => Promise<void>;
     succeed: (stageId: string, outputJson?: unknown) => Promise<void>;
     fail: (stageId: string, errorClass: string) => Promise<void>;
   };
   ```

   Server populates this with a thin wrapper around `heartbeatStageService`
   that captures the runId so adapters don't need to pass it. Adapters
   that opt in get explicit stage tracking; adapters that don't get the
   synthetic single-stage default.

## Routes

`GET /api/heartbeat-runs/:runId/stages` — list stages for a run.
Board + agent (with company scope) — same auth as run-detail views.

No mutation routes from the UI; stages are mutated only by the runtime.

## UI

`ui/src/components/StageTimeline.tsx` (new) — small horizontal timeline
component rendering the stages of a run, with status pills and duration
on hover. Embed in:

- `ui/src/pages/AgentDetail.tsx` — when viewing a specific run.
- `ui/src/pages/Issues.tsx` (or wherever runs surface) — collapsed
  inline.

Realtime: subscribe to the existing `heartbeat.run.event` live event
stream. When `eventType === "stage.*"`, re-fetch the stages list.
(Future: emit a dedicated `mcp.stage_resolved`-style event so we don't
re-fetch on every transition — premature.)

## Tests

### `server/src/__tests__/heartbeat-stages.test.ts` (new)

1. `plan` creates a stage at the next ordinal; second plan goes to
   ordinal 2; concurrent plans don't collide (the unique index throws).
2. `start` is atomic CAS — `queued → running`. Second `start` returns
   null.
3. `succeed` is atomic CAS — `running → succeeded` with output. Cannot
   succeed a `queued` stage.
4. `fail` mirrors `succeed` for the failure path; `errorClass` is
   preserved.
5. `skip` works from `queued`; doesn't work from `running` (use cancel).
6. `cancelAllForRun` flips every non-terminal stage to `cancelled`.
7. Each transition writes a `heartbeat_run_events` row with a matching
   `eventType`.

### `server/src/__tests__/heartbeat-stage-integration.test.ts` (new)

1. Claiming a run with no stages auto-creates the `execute` stage.
2. Finalizing a run with a running `execute` stage transitions both.
3. An adapter that calls `ctx.stages.plan / start / succeed / plan / start
   / fail` produces a 2-stage run with the right ordinals and statuses.
4. Cost events written during the `running` window of a specific
   stageId carry that `stageId` on the row.

### `ui/src/components/StageTimeline.test.tsx` (new)

1. Renders pills for each stage with the correct status colors.
2. Live-event update triggers a refetch.

## Files to create or modify

**New:**
- `packages/db/src/schema/heartbeat_run_stages.ts`
- `packages/db/src/migrations/00XX_heartbeat_run_stages.sql` (idempotent)
- `packages/db/src/migrations/meta/00XX_snapshot.json` (from `db:generate`)
- `server/src/services/heartbeat-stages.ts`
- `server/src/routes/heartbeat-stages.ts` (single GET route, mount in
  `routes/index.ts`)
- `server/src/__tests__/heartbeat-stages.test.ts`
- `server/src/__tests__/heartbeat-stage-integration.test.ts`
- `ui/src/components/StageTimeline.tsx`
- `ui/src/components/StageTimeline.test.tsx`
- `ui/src/api/heartbeatStages.ts`

**Modified:**
- `packages/db/src/schema/cost_events.ts` — add `stageId` column
  (idempotent ADD COLUMN; same migration as above)
- `packages/db/src/schema/index.ts` — re-export `heartbeatRunStages`
- `packages/adapter-utils/src/types.ts` — extend `AdapterExecutionContext`
  with `stages?`
- `server/src/services/heartbeat.ts` — claim hook (default stage),
  finalize hook (cascade transition), cancel hook (cancel stages)
- `server/src/services/costs.ts` — `createEvent` accepts optional
  `stageId` and persists it
- `ui/src/pages/AgentDetail.tsx` — embed `<StageTimeline runId={...} />`
- `ui/src/lib/queryKeys.ts` — add `heartbeatStages.list(runId)`

## Verification (run from repo root, in order)

1. `pnpm --filter @paperclipai/db build`
2. `pnpm --filter @paperclipai/db run check:migrations` — snapshot must
   match the new migration (this CI gate has existed since `7902e845`).
3. `pnpm db:migrate` — applies cleanly on dev DB.
4. `pnpm db:generate` — must report "No schema changes".
5. `pnpm -r typecheck`.
6. New tests pass: `pnpm --filter @paperclipai/server exec vitest run
   src/__tests__/heartbeat-stages.test.ts
   src/__tests__/heartbeat-stage-integration.test.ts --reporter=dot`.
7. UI: `pnpm --filter @paperclipai/ui exec vitest run
   src/components/StageTimeline.test.tsx --reporter=dot`.
8. Full server suite: `pnpm --filter @paperclipai/server exec vitest run
   --reporter=dot`. The pre-existing
   `heartbeat-comment-wake-batching.test.ts` flake is acceptable;
   nothing else should regress.
9. UI suite: `pnpm --filter @paperclipai/ui exec vitest run --reporter=dot`.
10. UI build: `pnpm --filter @paperclipai/ui build`.

## Risks and migration notes

- **The synthetic `execute` stage** is the trickiest piece. Every
  existing test that asserts on `cost_events` or run finalization will
  see a new stage row in the same companyId scope. Run the full server
  suite early — likely 1-2 fixture updates.
- **Cost-events backfill is optional but useful.** Past `cost_events`
  rows will have `stageId=null`. UI stage-level cost breakdowns will
  show "$X attributed pre-stage-tracking" for old runs.
- **Plugin-job runs are not affected.** Stages live on `heartbeat_runs`
  only. `plugin_job_runs` is a separate runtime.
- **Adapter opt-in.** No adapter is forced to call `ctx.stages.*`. The
  synthetic stage covers the no-opt-in case, so cutover is incremental:
  claude-local can start emitting stages, others follow as needed.
- **Reaper.** The existing `reapOrphanedRuns` reaps stuck *runs*. When
  it cancels a run, `cancelAllForRun` cascades to stages. A future
  follow-up could add a stage-level reaper (e.g. a stage stuck in
  `running` for > 1h while its run keeps progressing) — out of scope.

## Out of scope (documented for the next planner)

- Stage retries (`retryStageId` chain, similar to `retryOfRunId` on
  `heartbeat_runs`). Nice to have; not needed for the skill-analyzer
  unblock.
- Stage-level approval gates. The existing run-level
  `pre_run_cost_estimate` gate fires before any stage. A per-stage gate
  ("approve before sending to upstream LLM") is a follow-up.
- A per-stage timeout enforcer.
- Cross-run stage dependencies (see "Non-goals").
- UI for editing stages directly. Read-only render only.

## Estimated effort

~3 weeks of focused engineering for one developer, dominated by the
heartbeat.ts integration tests and the cost-events stageId migration
on a live DB.
