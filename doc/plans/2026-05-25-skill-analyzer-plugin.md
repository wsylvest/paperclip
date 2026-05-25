# Skill analyzer as a Paperclip plugin

**Status:** Planned · not started
**Tier 1 #3** of the gap analysis at `~/.claude/plans/playful-gathering-firefly.md`.
**Depends on:** Tier 1 #2 (first-class workflow stages — see
`doc/plans/2026-05-25-workflow-stages-within-runs.md`). Without stages,
the analyzer has no clean place to insert its output between "task
arrives" and "adapter executes".

## Context — why this is needed

Paperclip has `company_skills` (a static catalog of skills an agent
*can* use, configured at agent-creation time) and an MCP gateway
(`server/src/services/mcp/gateway.ts`) that exposes a merged tool
catalog at runtime. But **skill selection is static**: each agent has
a fixed set of skills assigned to its role, and every task that agent
runs uses the same selection.

A skill analyzer is the missing **dynamic** layer:

> Given this task, which skills and MCP tools should the agent actually
> use, and which can it ignore?

This matters for two reasons:

1. **Cost.** Putting every available tool description into the agent's
   context burns tokens linearly with skill catalog size. A 30-tool
   catalog can easily add 5-8k tokens to every prompt. Pre-filtering
   to the 3-5 relevant tools cuts cost noticeably.
2. **Reliability.** Models with too many tools available frequently
   pick the wrong one. Narrowing the catalog improves tool-call
   accuracy.

The plan from the gap analysis is to build this **as a plugin**, not as
a core service, so the core stays unopinionated about content vs. code
vs. arbitrary task domain.

## Non-goals

- Replacing static `company_skills` configuration. The analyzer is a
  pre-stage filter; static skill assignment remains the source of truth
  for what's *available* to the agent.
- Multi-turn skill negotiation. The analyzer runs once per task before
  execution and emits a snapshot. If the task evolves mid-run, the agent
  uses whatever it already has.
- A built-in LLM-powered analyzer. The first analyzer plugin can be a
  simple keyword/heuristic implementation; LLM-powered selection is
  natural follow-up work but not required for the unblock.

## Architecture

```
                                                       ┌─────────────────┐
                                                       │ skill_selected  │
                                                       │  event row in   │
                                                       │ heartbeat_run_  │
                                                       │     events      │
                                                       └────────▲────────┘
                                                                │
   ┌──────────┐    ┌──────────────────┐    ┌─────────────────┐  │
   │  Run     │───▶│ Stage: skill_    │───▶│  Stage:         │──┘
   │ created  │    │   analysis       │    │  execute        │
   └──────────┘    └────────┬─────────┘    └─────────────────┘
                            │
                            │  invoke tool 'analyzeTask'
                            ▼
                   ┌──────────────────┐
                   │ Skill analyzer   │
                   │     plugin       │
                   │ (sandboxed       │
                   │  worker)         │
                   └──────────────────┘
```

The analyzer plugin exposes a single agent-callable tool:

```
analyzeTask({
  taskTitle: string,
  taskBody: string,
  availableSkills: string[],        // from company_skills
  availableMcpTools: string[],      // from the MCP gateway tools/list
}) → {
  selectedSkills: string[],
  selectedMcpTools: string[],
  rationale: string,
}
```

The heartbeat runtime, on entering a new run, inserts a
`skill_analysis` stage (per Tier 1 #2). The stage either:

1. **Invokes the analyzer plugin** if installed and enabled for this
   company. The plugin's `analyzeTask` tool returns the filtered set;
   the runtime emits a structured `skill.selected` event into
   `heartbeat_run_events` with the result; the next stage (`execute`)
   reads that event and configures the adapter to only expose the
   selected subset.
2. **Skips** if no analyzer plugin is installed or the feature is
   disabled, transitioning the stage to `status='skipped'` with
   `reason='no_analyzer_installed'`.

The plugin is a normal Paperclip plugin sandboxed via the existing
plugin-worker manager (`server/src/services/plugin-worker-manager.ts`).
It declares the `skills.read` capability so it can read the catalog,
and nothing else.

## Schema additions

None. All persistence reuses existing tables:

- Selection output → `heartbeat_run_events` with `eventType='skill.selected'`
  and a typed payload `{ selectedSkills, selectedMcpTools, rationale }`.
- Per-stage status → `heartbeat_run_stages` (the new table from Tier 1 #2).
- Plugin install / enablement → existing `plugins` + `plugin_company_settings`.

This is deliberately schema-free so an alternative analyzer
implementation (e.g. running in the main process, or via an LLM
provider call) can swap in without DB changes.

## Plugin contract

New convention: a plugin that wants to participate in skill analysis
declares `capabilities: ["skill-analyzer"]` in its manifest. The
heartbeat runtime queries `pluginRegistryService(db).listEnabled(companyId)`,
filters by capability, and picks the highest-priority installed
analyzer (or the only one — pluralism is a follow-up).

The plugin's `analyzeTask` tool gets exposed via the existing plugin
tool registry (`server/src/services/plugin-tool-registry.ts`). The
runtime invokes it via `plugin-tool-dispatcher.ts` exactly like any
other plugin tool call — sandboxed, capability-gated, rate-limited.

Input/output shape is enforced by a Zod schema co-located with the
plugin spec at `packages/shared/src/validators/skill-analyzer.ts`:

```ts
export const skillAnalyzerRequestSchema = z.object({
  taskTitle: z.string(),
  taskBody: z.string(),
  availableSkills: z.array(z.string()),
  availableMcpTools: z.array(z.string()),
});

export const skillAnalyzerResponseSchema = z.object({
  selectedSkills: z.array(z.string()),
  selectedMcpTools: z.array(z.string()),
  rationale: z.string(),
});
```

The runtime validates the response and rejects malformed payloads
without falling back to "use all skills" — a misbehaving analyzer should
be loud, not silently expand the tool surface.

## Server integration

`server/src/services/skill-analysis.ts` (new):

```ts
export function skillAnalysisService(db: Db) {
  return {
    /**
     * Runs the analyzer for a given heartbeat run. Returns the selection
     * if an analyzer was invoked, or null if no analyzer is installed
     * (caller should skip the stage).
     */
    analyze(runId: string): Promise<SkillSelection | null>;
  };
}
```

The implementation:

1. Looks up the analyzer plugin for the run's company.
2. If none, returns null.
3. Reads the run's issue, the company's enabled skills, and the MCP
   tool catalog for that agent.
4. Dispatches `pluginToolDispatcher.invoke(plugin.id, 'analyzeTask', input, ctx)`.
5. Validates the response with the shared Zod schema.
6. Emits the `skill.selected` event.
7. Returns the selection.

The heartbeat runtime calls this in a new pre-execute hook positioned
before the existing `execute` stage:

```ts
// In server/src/services/heartbeat.ts::executeRun, after claim
const skillStage = await stages.plan(runId, "skill_analysis");
await stages.start(skillStage.id);
const result = await skillAnalysisService(db).analyze(runId);
if (result === null) {
  await stages.skip(skillStage.id, "no_analyzer_installed");
} else {
  await stages.succeed(skillStage.id, result);
}
// Now plan and run the execute stage as today.
```

## Adapter integration

Adapters that want to honor the selection read the `skill.selected`
event from `heartbeat_run_events` and pass the filtered tool list to
their underlying CLI. For MCP-aware adapters (the 5 wired in commit
`03ff4cbd`), this means writing a narrower `mcpServers[].allowedTools`
field into the materialized config.

Adapters that don't honor the selection still work — they just expose
the full catalog as today. Cutover is incremental.

## Example plugin

Ship a reference implementation at
`packages/plugins/examples/plugin-skill-analyzer-keyword-example/`.
It uses a simple keyword-overlap heuristic:

1. Tokenize taskTitle + taskBody.
2. For each available skill / MCP tool, score by token overlap with
   its description.
3. Select top N (default 5) above a relevance threshold.

This is intentionally dumb so it's a clear template for replacement.
Cost: zero LLM calls. Effective enough as a baseline to compare against
future LLM-powered analyzers.

## Tests

### `server/src/__tests__/skill-analysis-service.test.ts`

1. No analyzer installed → returns null.
2. Analyzer installed + returns valid selection → service emits
   `skill.selected` event with the result.
3. Analyzer returns malformed selection (e.g. references unknown skill
   names) → validation fails, service throws, stage is marked failed.
4. Analyzer plugin times out (>15s) → reuses the existing plugin
   timeout error; stage is marked failed with errorClass='timeout'.

### `server/src/__tests__/skill-analysis-integration.test.ts`

1. End-to-end: a fixture run goes through `skill_analysis` (succeeded
   with selection event) → `execute` (sees the filtered tool list).
2. End-to-end with no plugin installed: `skill_analysis` is skipped,
   `execute` runs with the unfiltered catalog (current behavior).

### `packages/plugins/examples/plugin-skill-analyzer-keyword-example/src/index.test.ts`

1. Keyword overlap scoring: a "write a markdown blog post" task selects
   the markdown and writing skills, not the database skills.
2. Empty input → empty selection.
3. Threshold filtering.

## Files to create or modify

**New:**
- `packages/shared/src/validators/skill-analyzer.ts`
- `packages/plugins/examples/plugin-skill-analyzer-keyword-example/`
  (full plugin package: package.json, manifest, src/index.ts, tests)
- `server/src/services/skill-analysis.ts`
- `server/src/__tests__/skill-analysis-service.test.ts`
- `server/src/__tests__/skill-analysis-integration.test.ts`

**Modified:**
- `packages/shared/src/validators/index.ts` — export the new schemas
- `server/src/services/heartbeat.ts` — pre-execute `skill_analysis`
  stage (depends on Tier 1 #2 being live)
- One adapter (suggest `claude-local`) — honor the
  selection when writing `.mcp.json`. The other four follow as
  follow-up work in separate commits.

**No schema changes.**

## Configuration

- `PAPERCLIP_SKILL_ANALYZER_ENABLED` (default `true`). When `false`,
  the heartbeat runtime skips the `skill_analysis` stage even if a
  plugin is installed.
- Per-company toggle via `plugin_company_settings.enabled` — already
  exists; no new column.

## Verification

1. `pnpm --filter @paperclipai/shared build`
2. `pnpm --filter @paperclipai/plugin-skill-analyzer-keyword-example build`
3. `pnpm -r typecheck`
4. Plugin tests pass: `pnpm --filter @paperclipai/plugin-skill-analyzer-keyword-example
   exec vitest run --reporter=dot`
5. Server tests pass: `pnpm --filter @paperclipai/server exec vitest run
   src/__tests__/skill-analysis-service.test.ts
   src/__tests__/skill-analysis-integration.test.ts --reporter=dot`
6. Full server suite: `pnpm --filter @paperclipai/server exec vitest run
   --reporter=dot`. The pre-existing
   `heartbeat-comment-wake-batching.test.ts` flake is acceptable.
7. UI build still green: `pnpm --filter @paperclipai/ui build`
   (no UI changes, but the plugin lists the new plugin type in the
   plugin manager — manual smoke).

## Risks

- **Plugin compute cost.** Each run now triggers a plugin invocation
  (~10-50ms for the keyword-heuristic example). For instances running
  thousands of runs an hour, that's measurable. Mitigation: the gate
  feature flag is per-instance, and a future cache (taskHash → selection)
  is trivial to add if needed.
- **Wrong selection.** A bad analyzer can starve an agent of necessary
  tools. The plugin author owns this risk; the runtime falls back
  loudly (validation error → stage fails) rather than silently. A
  per-company override "always use all skills" toggle is available via
  the env flag and via disabling the plugin.
- **Coupling to stages.** This plan assumes Tier 1 #2 stages exist. If
  #2 slips, an interim implementation can short-circuit the analyzer
  into a hidden pre-execute call that emits the event but doesn't
  create a stage row — uglier but unblocks the analyzer independently.

## Out of scope (documented for the next planner)

- LLM-powered analyzer plugins (Claude / GPT / Gemini-driven selection).
  Build after baseline keyword plugin proves the contract.
- Multi-analyzer voting / ensembling.
- Per-tool confidence scoring on selections.
- A UI for previewing what an analyzer would select for a given task
  before submitting. Useful debugging tool; out of scope for the
  unblock.
- Auto-tuning the selection threshold from historical run outcomes.

## Estimated effort

~1 week of focused engineering for one developer once Tier 1 #2 has
landed. Dominated by the example plugin's test fixtures and the
integration test that drives a full run through both stages.
