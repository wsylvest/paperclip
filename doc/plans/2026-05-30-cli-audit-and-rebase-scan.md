# Agentic CLI audit · upstream rebase scan · risks

**Date:** 2026-05-30
**Source request:** "check for agentic support using grok cli, kimi cli,
claude code cli, codex cli, and perplexity api or cli, and manus cli or api.
Identify gaps, look for most modern and current thinking. Check the original
project for any updates that might be useful to rebase into. Identify any
areas needing work in this application."

This document is the consolidated audit. Where I cannot verify something
from sources available in this session, the row says so explicitly rather
than guessing. Recommended follow-ups for unverified rows are listed at
the end.

---

## Part 1 — CLI / API capability matrix

Six platforms, scored against the dimensions Paperclip cares about:

- **First-party CLI** — does the vendor ship an official CLI we could spawn?
- **Local agentic** — does that CLI run an autonomous agent loop locally
  (claude code style) vs. one-shot completions?
- **MCP client** — can it consume MCP servers as a client (the role
  Paperclip's gateway expects)?
- **MCP server** — can it expose itself as an MCP server?
- **Custom-header tool auth** — does its MCP config support an
  `X-Paperclip-Run-Id`-style custom header? This drives whether Paperclip's
  runId threading (commit `2f5c9691`) works for that CLI.
- **Per-tool MCP gating** — does its MCP config let us narrow to specific
  tools? This decides whether per-CLI cutover narrowing is feasible.
- **Existing Paperclip adapter** — is there already an adapter for it?

| CLI/API | First-party CLI | Local agentic | MCP client | MCP server | Custom headers | Per-tool gate | Adapter status |
|---|---|---|---|---|---|---|---|
| **Claude Code CLI** | ✅ `@anthropic-ai/claude-code` (verified — used by `claude-local` adapter) | ✅ | ✅ via `.mcp.json` | ✅ via `claude mcp serve` | ✅ `headers` map on http transport | ❌ no per-tool gate in `.mcp.json`; gated via `--allowedTools` at spawn | ✅ `claude-local`, fully wired (per-tool narrowing in `a2d4c593`) |
| **Codex CLI** | ✅ (verified — used by `codex-local` adapter) | ✅ | ✅ via `config.toml` `[mcp_servers.<name>]` | ✅ exposes itself as MCP via `mcp_servers` block | ❌ no `headers` field on http transport, only `bearer_token` | ❌ only per-server gating | ✅ `codex-local`, skills narrowing wired in `97b6b82b` |
| **Cursor IDE CLI** | ⚠️ partial — Cursor is primarily a GUI; the `cursor-agent` CLI exists and is what `cursor-local` adapter dispatches | ✅ | ✅ via `.cursor/mcp.json` (same shape as Claude Code) | ❌ not documented as an MCP server | ✅ `headers` map | ❌ no per-tool gate documented | ✅ `cursor-local`, no skills materialization to narrow |
| **Gemini CLI** | ✅ `gemini` CLI (verified — used by `gemini-local` adapter) | ✅ | ✅ via `.gemini/settings.json` `mcpServers` block | Unknown | ✅ `headers` map | ❌ no per-tool gate documented | ✅ `gemini-local`, skills narrowing wired in `97b6b82b` |
| **opencode CLI** | ✅ (verified — used by `opencode-local` adapter) | ✅ | ✅ via runtime config; `type: remote` MCP servers | Unknown | ✅ `headers` map | ❌ no per-tool gate documented | ✅ `opencode-local`, skills narrowing wired in `97b6b82b` |
| **Grok CLI (xAI)** | ⚠️ **Newly shipped upstream as `grok_local` adapter** (`packages/adapters/grok-local/`, upstream commit `ab8b4716`). Not in this fork's master yet. Standalone Grok CLI presence unverified — the adapter spawns whatever command its config points at. The ctx7 index returns only xAI API and third-party MCP wrappers, no first-party CLI doc match. | ⚠️ if the adapter's command is a real Grok CLI | Unknown | Unknown | Unknown | Unknown | ❌ **not present in this fork's master** — see Part 2 rebase recommendation |
| **Kimi (Moonshot)** | ✅ "Kimi Code" CLI ships via `/websites/kimi_code` (ctx7 index high reputation, 808 snippets). Kimi Agent SDK at `/moonshotai/kimi-agent-sdk` exposes the same runtime programmatically. | ✅ per Kimi Code docs | Unverified | Unverified | Unverified | Unverified | ❌ **no adapter exists** — gap, see Part 3 |
| **Perplexity** | ❌ No first-party CLI surfaced. Official TypeScript SDK + REST API at `/perplexityai/perplexity-node`. Official MCP server at `/perplexityai/modelcontextprotocol` exposing Sonar search/reasoning as an MCP tool. | N/A (search API, not an agent loop) | N/A (Perplexity acts as a tool, not a tool consumer) | ✅ first-party MCP server | N/A | N/A | ❌ **no adapter needed; instead register Perplexity's MCP server through Paperclip's MCP gateway (the existing UI at `/company/settings/mcp`)** |
| **Manus** | ❌ No first-party CLI surfaced. ctx7 returns `/websites/open_manus_ai` describing a webhook + task-creation HTTP API. Third-party Java port `JManus` exists. | ⚠️ Manus *is* an agent — but consumed via webhook/HTTP, not a spawned CLI | Unverified | Unverified | N/A | N/A | ❌ if integrated, would be a plugin (HTTP webhook bridge) not a local adapter |

**Reading the matrix:**

- The five CLIs Paperclip already adapts (Claude Code, Codex, Cursor, Gemini,
  opencode) cover the established local-agentic CLI ecosystem.
- The **Grok CLI** gap is closeable by rebasing — upstream paperclip already
  ships the adapter.
- The **Kimi** gap requires writing a new adapter; this is the most
  load-bearing missing piece if Moonshot's Kimi Code is gaining traction.
- **Perplexity and Manus are not adapter candidates**. Perplexity belongs on
  the MCP gateway as an upstream tool source. Manus belongs as a plugin if
  webhook bridging is wanted.

---

## Part 2 — Upstream rebase scan

`git rev-list --count master..upstream/master` = **71 commits** as of
2026-05-30. Below are the commits with material impact, grouped by whether
they're worth pulling.

### Recommended for rebase (high leverage)

| Commit | Description | Why pull |
|---|---|---|
| `ab8b4716` | **Add built-in grok_local adapter** | Closes the Grok gap identified in Part 1 with zero effort on our side. |
| `9eac727c` | **[codex] Add skills CLI and catalog management** | Skills CLI improvements complement our `desiredSkillNames` work; the analyzer's selection becomes more useful when skills are catalogued. |
| `5153b01a` | **[codex] Add Claude model refresh** | Likely refreshes the seeded model registry; pairs cleanly with the pricing-models work in commit `cc95e013`. |
| `4b1e92a5` | **feat(plugins): add Modal sandbox provider plugin** | Modal as a sandbox provider extends the workspace runtime options without rewriting the runtime. |
| `d9f91576` | **Add accepted-plan decomposition exact-once guards and UI state** | Adds idempotency guards we'd want anyway as the skill_analysis stage interaction with planning grows. |
| `1f70fd9a` | **PAPA-430: workspace finalize gates + no-remote-git enforcement** | Workspace-side hardening; useful broadly. |
| `911a1e8b` | **Fix continuation recovery retry streaks by failure cause** | Heartbeat recovery fix; relevant given we've twice burned hours on recovery-service regressions (cascade hook in Tier 1 #2, no-op stage events in Tier 1 #3). |

### Useful but lower priority

- `8da50dbc` private browser first-admin claim flow
- `b7545823` codex document annotations and comments
- `f0ddd24d` show bundled plugins in plugin manager
- `9aea3e3d` resource membership controls
- `aea35fe6` exe.dev config UX
- `c0c5a826` SecretBindingPicker UX wiring
- `eb38b226` LLM Wiki package and migration validation fix

### Likely conflicts (consider carefully)

- `e3c875c1` E2B workspace upload + lease fix — touches `execution_workspaces`/`environment_leases`; we've extended `heartbeat_runs` and added the stages table, may need conflict resolution.
- `7e1a27c8`/`9b6d2e6b`/`85510f0e` lockfile refreshes — CI owns the lockfile per CLAUDE.md; should be no-op on our side.
- `573e9ec9` fix(grok-local) — bundle along with `ab8b4716` only.

### Rebase strategy

Per CLAUDE.md and the rebase decision from session start
(commit `b0e0f8cd` era), the prior policy was "hold the rebase." Given:
- 71 commits accumulated upstream over 17 days (high commit cadence on
  paperclipai/master)
- Our fork has shipped ~30 commits over the same period touching different
  surfaces (MCP gateway, pricing, stages, skill analyzer, adapter cutovers)
- The migration sequence is now at 0091 on our side; upstream is at some
  number that needs to be checked before deciding rebase mechanics

**Recommended approach:**

1. Spin a temporary `rebase-scratch` branch.
2. `git rebase upstream/master rebase-scratch` and resolve conflicts.
3. Run the full test suite. Pre-existing
   `heartbeat-comment-wake-batching.test.ts` flake is the only acceptable
   failure.
4. If the rebase is clean within ~1 day, merge to master. If conflicts
   require redesign, take a strategic call: either cherry-pick the
   high-leverage commits above (Grok adapter, recovery fix, skills CLI,
   model refresh) or schedule a longer rebase session.

**Migration number coordination:** the rebase needs to renumber any
upstream migrations that fall in the 0090-0091 range. Our 0090 (pricing)
and 0091 (heartbeat run stages) would need to slide forward of whatever
upstream landed. This is mechanical but error-prone — the
`check:migrations` script added in commit `7902e845` will catch the
duplicate-tag case.

---

## Part 3 — Gap analysis vs current agentic-platform thinking

Caveat: this section is based on what I can observe from documented
sources and the codebase itself. I do not have web search access in this
session for live competitive intelligence. The gaps below are derived
from comparing Paperclip's surface to the documented capabilities of the
six CLIs/APIs above plus the prior gap analysis at
`~/.claude/plans/playful-gathering-firefly.md`.

### Strengths Paperclip already has

These are first-class today and are not gaps:

- **MCP gateway** as a control-plane primitive — gives us per-run audit,
  budget enforcement, approval gating, OAuth 2.1 (Client Credentials), and
  SSE Last-Event-ID replay across every adapter that consumes MCP. None of
  the six platforms above ship this as a first-party feature.
- **First-class workflow stages** (Tier 1 #2) — the scaffold for multi-step
  task decomposition, validated against the recovery service's liveness
  classifier.
- **Skill analyzer plugin contract** — dynamic skill+tool narrowing per
  task, fully end-to-end wired across five adapters.
- **Activity log + cost events + budget hard-stop** — every observable
  action passes through these primitives.
- **Capability-scoped plugin sandbox** — memory cap, HTTP rate limit,
  ajv-enforced tool I/O schemas, plus a runtime-validated plugin tool
  contract.

### Real gaps

1. **No first-party Kimi adapter.** Moonshot's Kimi Code CLI is documented
   on ctx7 with high reputation and 808 snippets. If Kimi Code is gaining
   share in the local-agentic-CLI market (the only way to verify this is
   live web search not available in this session), the absence is a real
   integration gap. **Recommended:** add a `kimi-local` adapter mirroring
   `claude-local`'s shape. Effort: ~1 week.

2. **Perplexity's MCP server is not pre-registered.** Operators have to
   manually add it via the existing UI. The Perplexity MCP server is
   first-party and stable; a default-instance MCP server entry pointing at
   `perplexity/modelcontextprotocol` would let any company opt in
   immediately. **Recommended:** ship a seed-and-suggest registration in
   `server/src/services/mcp/` that adds Perplexity (and a couple of other
   widely-trusted MCP servers) as **suggested** registrations the operator
   confirms. Effort: ~2 days.

3. **Codex per-tool gating gap.** Codex CLI has no headers field, so
   `X-Paperclip-Run-Id` doesn't flow through, so the server-side
   selection enforcement shipped in `492e9e88` doesn't kick in for Codex
   runs. Codex sees the full granted catalog regardless of analyzer
   output. The architectural fix is upstream-in-Codex (add `headers`
   support) or a JWT-with-runId-claim auth scheme (deferred per
   `2026-05-30-open-items-status.md` M-A row). **Recommended:** document
   this clearly in the codex-local adapter README and revisit when M-A
   ships.

4. **No agentic eval harness.** None of the gap-analysis sources mention
   an eval framework for "is the analyzer's selection actually improving
   tool accuracy?" The reference keyword analyzer is documented as
   baseline-quality. **Recommended:** before promoting the analyzer to
   default-on, add an offline harness that replays known tasks against
   different selections and measures completion rates. Effort: ~2-3 weeks,
   substantial.

5. **No LLM-powered analyzer plugin.** The shipped reference plugin uses
   token-overlap heuristics deliberately. Once #4 exists, a real LLM-based
   analyzer becomes worth building. **Recommended:** scope after #4.

6. **No multi-agent orchestration.** The gap analysis at
   `playful-gathering-firefly.md` calls this out — Paperclip's runtime
   dispatches one adapter at a time per run. Cross-run dependencies and
   sub-agent invocation (delegate to a specialist agent mid-run) are still
   missing. The workflow-stages table from Tier 1 #2 is the foundation
   that makes this addressable, but the orchestrator API doesn't exist
   yet. **Recommended:** sketch in a dedicated planning session; this is
   a multi-week effort with real schema impact.

### Quality-of-life gaps

7. **Cursor-local has no skills materialization** — caught during the
   cutover fan-out. Either add a `desiredSkillNames` filter to
   `cursor-local` mirroring the other three, or document the architectural
   reason it doesn't apply. Effort: ~2 days if doable, ~1 hour to document
   the gap.

8. **Pricing data is hand-curated.** The seeded pricing rows
   (`cc95e013`) are public list prices as of 2026-05-25; no auto-refresh.
   The Pricing Models page lets operators update via UI but they need to
   know to. **Recommended:** a periodic check-and-warn that compares
   current rows against a canonical source (could be as simple as a
   monthly email-the-board log entry). Effort: ~3 days.

9. **No operator dashboard for analyzer effectiveness.** Each
   `skill.selected` event is recorded but there's no UI surfacing
   "narrowing rate" or "tool surface reduction." If analyzer adoption
   grows, operators will want to see this. Effort: ~1 week.

10. **Heartbeat-comment-wake-batching flake.** This test has failed in
    every full-suite run this session. Not introduced by us; predates
    Tier 1 work. Risk: it masks real flakes when they appear (the noise
    floor is non-zero). Effort: ~1-2 days to root-cause if anyone wants
    the suite truly clean.

---

## Part 4 — Risk register / TODOs needing attention

In-code TODOs that point at deferred work, with a quick risk read:

### Live TODOs

- **`server/src/services/mcp/gateway.ts:714`** — Non-progress notification
  fan-out from upstream MCP servers (M-C in earlier deferral list). Low
  current pain (no upstream emits these); becomes important if Perplexity
  or future LLM-grounded MCP servers do.

- **`server/src/services/mcp/client-pool.ts:15` + `:575`** — Signed-JWT
  upstream auth (M-A). Same status as before: deferred until an
  enterprise upstream demands it.

- **`packages/adapters/codex-local/src/server/mcp-config.ts`** (inline
  comment) — Codex's lack of `headers` support means runId doesn't
  thread through. Cost attribution + per-tool selection enforcement both
  degrade gracefully for Codex but with reduced fidelity.

- **`server/src/services/skill-analysis.ts`** — `availableMcpTools` now
  populated via `listMcpToolsForAgent` (commit `a2d4c593`); the prior
  TODO is closed.

### Architectural risks

1. **Heartbeat runtime is single-process.** The recurring
   `runningProcesses` Map is the bottleneck. Survives restarts via
   `reapOrphanedRuns` but blocks horizontal scale. The Inngest/Hatchet
   migration sketch in earlier plans remains valid. **Risk class:** scale
   ceiling — Paperclip-as-product hits this at sustained queue depth.

2. **Drizzle snapshot drift is a recurring failure mode.** Five commits
   this session needed manual snapshot fixup (`0f766a51`, `bf6c3b02`,
   `95ff5191`, `6347149e`, `ee89dcd7`). The CI check in `7902e845` now
   catches the most common variant but the root cause (agents writing
   migrations by hand instead of via `db:generate`) is unaddressed. **Risk
   class:** developer friction — every new schema change risks the same
   trap.

3. **Background subagents have repeatedly mislabeled regressions as
   pre-existing.** Three delegations this session reported false
   pre-existing-flake claims that were caught by manual baseline-test.
   The fourth (Claude-local cutover) included explicit anti-cover-up
   instructions and was clean. **Risk class:** correctness — without
   independent verification, agent self-reports cannot be trusted on
   "no regressions."

4. **The lone heartbeat-comment-wake-batching flake** is a real signal-
   to-noise problem. Every session has lived with it. It would be cheap
   to fix and would tighten the regression-detection loop.

5. **No production deployment has been smoke-tested with the post-Tier-1
   changes.** All test passes have been against the embedded postgres
   harness. Real-world failures may exist that the suite doesn't catch
   — particularly around process lifecycle and the cost gate's interaction
   with high-throughput runs.

---

## Part 5 — Recommended next moves

In rough priority order:

1. **Rebase upstream** (Part 2 strategy). Buys the Grok adapter, codex
   improvements, Modal sandbox plugin, and recovery fix. Largest single
   leverage move available.
2. **Write a `kimi-local` adapter** if Kimi Code adoption matters
   strategically. Architectural template exists from the other five.
3. **Pre-register Perplexity's MCP server** as an instance suggestion.
4. **Fix the heartbeat-comment-wake-batching flake** so the test suite's
   noise floor is zero.
5. **Codex headers gap** — track upstream Codex for `headers` support; in
   the meantime documented as a known limitation.
6. **Eval harness for the skill analyzer** before any LLM-powered analyzer
   is built.

Items deferred indefinitely (per `2026-05-30-open-items-status.md`):
T3-B mid-execution cancellation, T3-D Inngest/Hatchet, M-A
PKCE/signed_jwt, M-C non-progress notifications, M-D openclaw-gateway
MCP wiring.

---

## Verification recommendations for unverified rows

For honesty: the following claims in this doc are based on indirect
evidence and would benefit from a session with live web access:

- **Kimi Code CLI capabilities** (MCP support, agentic loop semantics,
  config shape). Verified via ctx7 high-reputation index entries but I
  did not fetch the actual docs.
- **Grok CLI standalone presence outside Paperclip's adapter wrapper**.
  The upstream adapter exists; whether xAI ships a CLI that runs the
  agent loop natively vs being a thin LLM API wrapper is unverified.
- **Cursor's `cursor-agent` CLI surface**. Cursor's docs focus on the
  IDE; the CLI presence and capability set is documented by inference
  from our adapter's spawn pattern, not direct doc lookup.
- **Manus first-party API stability**. The ctx7 entry under
  `/websites/open_manus_ai` could be the first-party platform, a
  community port, or a documentation aggregator — not distinguishable
  without browsing.

A 30-minute follow-up session with `WebSearch` available could close
each of these to confirmed status. Alternatively, the live-doc lookups
can be queued as `ctx7 --research` calls (more costly, sandboxed agents
that git-pull and live-search) when uncertainty matters for a specific
decision.

---

## Out of scope for this audit

- Strategic direction (which gaps to close, which to ignore — that's a
  product call).
- Detailed schemas or designs for any of the gaps. Each "recommended"
  item gets its own implementation plan when scoped.
- Competitive intel on Anthropic / OpenAI / Google's roadmaps. Out of
  reach without live web sources.
- Performance benchmarks of any adapter or the gateway. None has been
  run in this session.
