# Tier 2 (content orchestration) — deferred

**Status:** Decision record · no code action
**Source:** Gap analysis at `~/.claude/plans/playful-gathering-firefly.md` §8 + "Recommended next moves" Tier 2.
**Date:** 2026-05-25.

## Summary

Tier 2 of the gap analysis proposes pivoting Paperclip toward content
orchestration:

- (#4) `content_drafts` + `platforms` + `clients` schema, with CRUD UI
  (~6 weeks).
- (#5) Media-generation adapters as plugins — Stability AI, ElevenLabs,
  etc. (~2 weeks per provider, after #4).
- (#6) Publishing-target plugins — LinkedIn, X, Substack, generic
  webhook (~1-2 weeks per target, after #4).

After explicit review, **Tier 2 is deferred indefinitely.** Paperclip
remains a code-agent control plane. None of the schema, plugin, or UI
work proposed in #4–#6 will be undertaken in this branch until the
strategic question is reopened.

This document exists so a future planner doesn't re-evaluate from
scratch. It records the inputs to the decision and the conditions that
would change it.

## Reasoning

1. **No product signal.** The gap analysis was a comparison against a
   target architecture for a multi-agent **content** platform. There
   is no customer, business unit, or roadmap commitment behind Paperclip
   pivoting in that direction.

2. **Cost is large and front-loaded.** Tier 2 #4 alone is ~6 weeks
   of engineering before any media generation or publishing ships. It
   touches: 3 new tables (`content_drafts`, `platforms`, `clients`),
   their CRUD services, their CRUD UI pages, a new approval type
   (`publish_draft`), a new draft-preview component, and a new sidebar
   section. The cost is irreversible once shipped — the table semantics
   become contracts the codebase carries forward.

3. **Tier 1 captures the high-leverage delta already.** The gap
   analysis identified Tier 1 (pricing, stages, skill analyzer) as
   "high leverage, modest cost, reuses existing primitives." Tier 1 #1
   was shipped this session (commits `9df115ae` and `cc95e013`). Tier 1
   #2 and #3 are planned (`doc/plans/2026-05-25-workflow-stages-within-runs.md`
   and `doc/plans/2026-05-25-skill-analyzer-plugin.md`). Tier 2 is
   marked in the gap analysis as **"only worth it if pivoting toward
   content"** — it does not deliver value to the existing code-agent
   product.

4. **The primitives Tier 2 would build are not blocking anything
   else.** Drafts, platforms, and media generation do not unblock
   anything in the code-agent control plane. Skipping them carries no
   cost to the current product.

## What would re-open this decision

Any one of the following would warrant reconsidering:

- A real customer requirement for content-style workflows (draft
  generation + human approval + publish to LinkedIn / X / blog).
- A strategic decision to extend Paperclip's surface beyond code
  agents into general content/media work.
- An acquired adjacency (e.g. a content-marketing tool acquires or is
  acquired by Paperclip) that would benefit from shared runtime.
- A platform partner (Stability AI, ElevenLabs, Runway) building
  natively on Paperclip — in which case at least Tier 2 #5 becomes
  worth examining.

The technical evaluation in the gap analysis (`playful-gathering-firefly.md`
§8) remains accurate. Re-opening this decision means re-validating the
**business** case, not the technical scope.

## What we did this session instead

- Shipped Tier 1 #1 in full: pricing-models schema, pre-run cost gate,
  instance-admin UI, per-adapter `estimateCost()` for the 5 supported
  adapters, seeded current public-list pricing for Anthropic / OpenAI /
  Google.
- Wrote implementation plans for Tier 1 #2 (workflow stages within
  runs) and #3 (skill analyzer plugin) so they can be executed later
  without rediscovery.
- Wrote this deferral record.
- Wrote a Tier 3 prioritization plan
  (`doc/plans/2026-05-25-tier-3-polish.md`) listing the polish items
  worth pulling forward given the no-pivot decision.

## Pointers for a future planner

If Tier 2 is ever reopened, the relevant prior work to reuse rather
than reinvent:

- The `approvals` table (`packages/db/src/schema/approvals.ts`) is
  generic enough to handle a `publish_draft` approval type with no
  schema change. Mirror the patterns used for `pre_run_cost_estimate`
  (commit `9df115ae` extended `ApprovalPayload.tsx`) and
  `mcp_tool_call` (commit `6347149e`).
- The plugin sandbox (`server/src/services/plugin-worker-manager.ts`)
  is the correct host for media-generation plugins. Memory cap, HTTP
  rate limit, and capability allowlist already exist (commit
  `e7ff513e`). A media plugin declares `media.generate` capability and
  exposes a tool callable by agents.
- Plugin cost attribution to `cost_events` already works via the
  pattern landed for the MCP gateway in commit `95ff5191`. A media
  plugin just needs to insert `cost_events` rows after each generation
  with a `provider='stability'` / `'elevenlabs'` value.
- The `assets` table (`packages/db/src/schema/assets.ts`) is suitable
  for storing media outputs. A `content_drafts` table can reference
  asset ids without owning the storage.
- The proposed `content_drafts(id, companyId, clientId?, platformId?,
  body, metadata jsonb, generatedFromRunId, status, ...)` shape in
  `~/.claude/plans/playful-gathering-firefly.md` §8 is a reasonable
  starting schema.

These reuse paths mean Tier 2 #4-#6 would be **less expensive than the
~10-12 weeks estimated** if the reopening happens after Tier 1 #2 and
#3 land — workflow stages would give content workflows the same
multi-stage runtime they need.

## Out of scope for this record

- Whether Paperclip *should* pivot strategically. That's a product
  call, not a technical one. This record exists only to document that
  it currently isn't.
- Specific schemas for `content_drafts` / `platforms` / `clients`.
  Sketched in the gap analysis; full DDL belongs in an implementation
  plan if the decision is reopened.
- Vendor selection for media providers. Anthropic doesn't sell media
  generation; the choice between Stability / Runway / Midjourney /
  ElevenLabs / others is a procurement call separate from the
  architectural question.
