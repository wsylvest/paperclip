# Open items status — closure record

**Date:** 2026-05-30
**Context:** After shipping Tier 1 #2 (`37f21f23`), this doc closes the
remaining items from the Tier 3 prioritization
(`doc/plans/2026-05-25-tier-3-polish.md`) and from the gap analysis at
`~/.claude/plans/playful-gathering-firefly.md`. Each entry records the
current decision, what would reopen it, and where any in-code TODOs
already point.

This is a decision/status record. No code action.

---

## Tier 1 #3 — Skill analyzer plugin

**Status:** Planned · ready to build, blocked unblocked by Tier 1 #2.

**Plan reference:** `doc/plans/2026-05-25-skill-analyzer-plugin.md`.

**Why not in this session:** Tier 1 #2 (workflow stages) just landed
(`37f21f23`). The analyzer's hook point — a `skill_analysis` stage
inserted before `execute` — now has the primitive it depends on. The
plan estimates ~1 week of focused engineering; that's the next session's
work, not a 30-minute follow-up to a multi-hour stages commit.

**What reopens it:** Nothing. It's the natural next deliverable. The
plan doc has the schema sketch, file list, contract, test plan, and
verification commands all ready.

**Pointer:** When picking this up, search `server/src/services/heartbeat.ts`
for the line that creates the synthetic `execute` stage on claim. The
analyzer pre-stage inserts before that.

---

## T3-B — Mid-execution cancellation signal

**Status:** Deferred · no in-code TODO added.

**Why deferred:** Per `2026-05-25-tier-3-polish.md`, this matters only
when long-call workloads exist. Today's adapters all bound their own
tool calls (15s MCP tool timeout, plugin worker call cap, adapter
process kill on SIGTERM). The current pain point is non-existent: there
is no observed bug where a stuck mid-call adapter resists cancellation.

**What reopens it:** Either of:
- Media-generation workloads (Tier 2 #5) landing. A video render mid-
  flight will need a cancel signal that propagates through HTTP.
- An incident where a stuck mid-call tool consumed budget after a
  cancellation request.

**Scope when reopened:** ~1 week. Touches every adapter's tool call
path. Defer in scope by gating with a feature flag so it can be enabled
per-adapter as adapters are taught the new contract.

---

## T3-D — Horizontal scale on heartbeat runtime (Inngest / Hatchet)

**Status:** Deferred · sketched in an earlier session plan.

**Why deferred:** No observed throughput bottleneck. The in-memory
`runningProcesses` map in `heartbeat.ts` is the only blocker today, and
it survives process restarts via `reapOrphanedRuns` because the reaper
uses PID liveness, not in-memory state. Multi-week refactor for
hypothetical scale.

**What reopens it:** Either:
- Sustained queue depth where single-process heartbeat throughput is
  the demonstrated bottleneck (e.g. p95 claim-to-running latency above
  some threshold like 10s with non-trivial queue depth).
- A platform decision to multi-tenant Paperclip across nodes.

**Scope when reopened:** Multi-week. Pick between Inngest (SaaS-shaped,
hosted), Hatchet (Postgres-native, OSS, self-hostable), or Temporal
(industry standard, heavier). The prior sketch leaned Hatchet for the
"no SaaS dep" property.

---

## M-A — PKCE / signed_jwt auth for upstream MCP servers

**Status:** Deferred · in-code TODOs left in place from commit `ee89dcd7`.

**Why deferred:** No enterprise upstream MCP server today demands it.
Client Credentials (the shipped flow) handles every upstream that
exists. PKCE adds a browser-redirect callback path, state storage,
and a new instance-settings surface; that's substantial work for a
hypothetical need.

**Where the TODOs live:** `server/src/services/mcp/client-pool.ts`
inside the `oauth_ref` switch branch. `signed_jwt` throws
`UnsupportedTransportError` with a comment pointing at this doc.

**What reopens it:** Any customer or partner integration that requires
interactive OAuth (Authorization Code with PKCE) or asymmetric-key JWT
auth against their MCP server.

**Scope when reopened:** ~1-2 weeks. Adds a `/api/mcp/oauth/callback`
route, state-to-session correlation, refresh token storage in
`company_secrets` (keyed by mcp_server_id), and minor UI to surface
"Click to authorize" on a server registration.

---

## M-C — Non-progress notification fan-out

**Status:** Deferred · in-code TODO at `executeToolCall` in
`server/src/services/mcp/gateway.ts`.

**Why deferred:** Almost no upstream MCP server emits
`notifications/message`, `notifications/log`, or
`notifications/tools/list_changed` today. The progress-notification
fan-out we already ship (via per-call `onprogress`) covers the
common case.

**Note:** The Last-Event-ID replay buffer (commit `537b76a4`) would
automatically carry these notifications if/when the gateway starts
fan-out — no additional buffer work required.

**What reopens it:** An upstream MCP server we want to integrate that
emits one of these notification types (e.g. a tools/list_changed
emitter when the upstream adds a new tool mid-session).

**Scope when reopened:** ~2 days. Use the SDK's
`fallbackNotificationHandler` on the shared pooled client; broadcast
to all active sessions for that `(companyId, mcpServerId)` pair using
the existing `broadcastToSession` API.

---

## M-D — openclaw-gateway adapter MCP wiring

**Status:** Deferred · pending upstream research.

**Why deferred:** `packages/adapters/openclaw-gateway/` is the only
adapter that didn't receive MCP wiring in commit `03ff4cbd`. Unlike
the five other adapters that ship a per-CLI config file convention
(`.mcp.json` / `config.toml` / etc.), the openclaw gateway is itself
a routing layer — the wiring shape is non-obvious without first
understanding which downstream MCP capabilities openclaw is meant
to expose.

**What reopens it:** A spec or implementation decision on what
"openclaw + MCP" should mean operationally. Possibilities range from
"openclaw is itself an MCP server" (the gateway aggregates its own
tools) to "openclaw materializes MCP config for the downstream agent
the gateway is talking to" (mirror of the five other adapters).

**Scope when reopened:** ~1-2 weeks after the spec call lands.

---

## Summary table

| Item | Status | Tracking |
|---|---|---|
| Tier 1 #3 (skill analyzer) | Ready to build next | `2026-05-25-skill-analyzer-plugin.md` |
| T3-B (mid-execution cancellation) | Deferred — no current pain | No in-code TODO |
| T3-D (Inngest/Hatchet migration) | Deferred — no throughput bottleneck | Sketched in prior session |
| M-A (PKCE / signed_jwt) | Deferred — no enterprise upstream demands it | TODO in `client-pool.ts` |
| M-C (non-progress notifications) | Deferred — no upstream emits these | TODO in `gateway.ts::executeToolCall` |
| M-D (openclaw-gateway MCP) | Deferred — needs spec call | None — adapter package untouched |

The open-items list from the May 25 plan is now closed. Reopening any
item is a strategic call; the technical scope for each is documented
above and in the originating plan docs.
