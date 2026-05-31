 # Paperclip — Product Requirements Document

**Version:** 0.3.1
**Status:** Backwards-engineered from source (master)
**Audience:** Product, Engineering, Design, GTM

> Paperclip is open-source orchestration for zero-human companies. It is a self-hosted Node.js server + React UI that runs a team of AI agents as if they were a company — with an org chart, goals, budgets, ticketing, approvals, and an audit log. Bring your own agents (Claude Code, Codex, Cursor, Gemini, OpenClaw, plain HTTP); Paperclip coordinates them.
>
> _If OpenClaw is an employee, Paperclip is the company._

---

## Table of Contents

1. [Product Overview & Personas](#1-product-overview--personas)
2. [Domain Model & Invariants](#2-domain-model--invariants)
3. [The Customer Company (Org)](#3-the-customer-company-org)
4. [Agents](#4-agents)
5. [Skills](#5-skills)
6. [Tasks (Issues)](#6-tasks-issues)
7. [Projects & Execution Workspaces](#7-projects--execution-workspaces)
8. [Goals](#8-goals)
9. [Routines (Scheduled Work)](#9-routines-scheduled-work)
10. [Heartbeat & Wake System](#10-heartbeat--wake-system)
11. [Approvals & Governance](#11-approvals--governance)
12. [Costs, Budgets & Finance](#12-costs-budgets--finance)
13. [Activity / Audit Log](#13-activity--audit-log)
14. [User Dashboard](#14-user-dashboard)
15. [User Inbox](#15-user-inbox)
16. [Settings (Company + Instance)](#16-settings-company--instance)
17. [Plugins & Extensibility](#17-plugins--extensibility)
18. [Realtime, Notifications & Mobile](#18-realtime-notifications--mobile)
19. [Authentication, Invites & Onboarding](#19-authentication-invites--onboarding)
20. [Non-Functional Requirements](#20-non-functional-requirements)
21. [Appendix A — REST API Surface](#21-appendix-a--rest-api-surface)
22. [Appendix B — Database Schema Summary](#22-appendix-b--database-schema-summary)

---

## 1. Product Overview & Personas

### 1.1 Vision

Paperclip lets a single human operate **many** autonomous AI companies the way a board operates portfolio companies: define the goal, hire the team, set budgets, approve major moves, and monitor work via tickets and dashboards. Agents work continuously on heartbeats, escalate to humans only when governance demands it, and are forcibly paused when budgets are exhausted.

### 1.2 What Paperclip is *not*

- **Not a chatbot.** Agents have jobs, not chat windows.
- **Not an agent framework.** Bring your own runtime (Claude Code, Codex, Cursor, Gemini, OpenClaw, HTTP). Paperclip orchestrates them.
- **Not a workflow builder.** No drag-and-drop pipelines. The model is a company, not a graph.
- **Not a prompt manager.** Agents bring their own prompts.
- **Not a code-review tool.** Paperclip orchestrates work; bring your own review process.
- **Not a single-agent tool.** Twenty agents is the sweet spot; one agent is over-tooled.

### 1.3 Personas

| Persona | Description |
|---|---|
| **Board Operator** | The human owner. Cookie/session auth. Full control: hires, fires, approves, sets budgets, reads everything. |
| **CEO Agent** | A privileged agent that may modify company branding, hire agents, manage skills, and approve routine actions inside its own company. Cannot leave its company. |
| **Worker Agent** | Any agent below CEO. Bearer-token auth via `agent_api_keys`. Operates on assigned issues, comments, attachments, work products, and routine outputs. |
| **Instance Admin** | Operator of a multi-tenant Paperclip deployment. Owns instance-wide settings, plugin install/uninstall, multi-company access. |
| **External Webhook Caller** | Public callers hitting `/api/routine-triggers/public/{publicId}/fire` with HMAC-signed payloads. |

### 1.4 Deployment Modes

Defined in `doc/DEPLOYMENT-MODES.md` and enforced via middleware:

| Mode | Exposure | Default | Behavior |
|---|---|---|---|
| `local_trusted` | `private` | dev | Single-operator. Company deletion enabled. No external auth. |
| `authenticated` | `private` | Tailscale / VPN | Better-auth sessions. Company deletion off. |
| `authenticated` | `public` | Internet-facing | Same as private but with stricter hostname guards (`server/src/middleware/private-hostname-guard.ts`). |

### 1.5 Differentiators

| Capability | Why it matters |
|---|---|
| **Atomic execution** | Task checkout and budget enforcement are atomic — no double work and no runaway spend. |
| **Persistent agent state** | Sessions resume across heartbeats; agents don't restart from scratch. |
| **Runtime skill injection** | Skills land in the agent's home dir at run time without retraining. |
| **Governance with rollback** | Approval gates, revisioned config, safe rollback. |
| **Goal-aware execution** | Tasks carry full goal ancestry so agents always see the *why*. |
| **Portable company templates** | Export/import orgs, agents, and skills with secret scrubbing and collision handling. |
| **True multi-company isolation** | Every entity is company-scoped; one deployment = many companies, separate data and audit trails. |

---

## 2. Domain Model & Invariants

### 2.1 The six load-bearing invariants

From `AGENTS.md §5`. Routes and services both enforce these:

1. **Single-assignee task model.** An issue has at most one current assignee/run lock at any moment.
2. **Atomic issue checkout.** `checkout()` succeeds only if the issue is unassigned, currently assigned to the caller, or already locked by the same `executionRunId`. Prevents double-work.
3. **Approval gates for governed actions.** Hire, certain config changes, and budget overrides require board approval and emit `approvals` rows.
4. **Budget hard-stop auto-pause.** When a `budget_policies` threshold is exceeded with `hardStopEnabled=true`, in-flight work is cancelled and the scope (company / agent / project) is paused via `services/heartbeat.ts → cancelBudgetScopeWork`.
5. **Activity log entry on every mutation.** All mutating routes call `logActivity(...)`. The log is append-only and immutable.
6. **Company-scoped access enforced at routes *and* services.** No service trusts the route layer; both call `assertCompanyAccess` (or equivalent). Agent API keys cannot cross companies.

### 2.2 Two actor classes

| Actor | Auth | Scope | Notes |
|---|---|---|---|
| **Board** (human) | better-auth session cookie OR `board_api_keys` bearer | Multi-company (subject to membership grants) | In `local_trusted` mode, single implicit operator (`actorId=local-board`). |
| **Agent** | bearer token (`Authorization: Bearer …`) backed by `agent_api_keys` (hashed) and per-run JWT | Exactly one company; cannot cross | Per-run JWT minted by `createLocalAgentJwt` and injected as `PAPERCLIP_API_KEY`. Hash stored at rest; plaintext shown once at issue/claim time. |

### 2.3 Multi-company isolation

Every domain entity carries `companyId`. Middleware `actorMiddleware` resolves the actor; `assertCompanyAccess(req, companyId)` is called on every route. Memberships (`company_memberships`) and granular grants (`principal_permission_grants` keyed by `agents:create`, `tasks:assign`, etc.) gate finer-grained capabilities.

---

## 3. The Customer Company (Org)

### 3.1 Capabilities

- **Create** company (board-only when `requireBoardApprovalForNewAgents=false`; admins always allowed). Auto-creates `company_memberships` for the creator and a default budget policy.
- **List** companies — filtered by access; instance admins see all.
- **Read** detail — single company; CEO agents may read their own.
- **Update** — board may modify all fields. CEO agent restricted to `brandColor` and `logoAssetId` via `PATCH /branding`.
- **Archive** (soft-pause) — sets `status` and `pauseReason`/`pausedAt`. Reversible.
- **Delete** (hard) — board-only; clears related data. Gated globally by `PAPERCLIP_ENABLE_COMPANY_DELETION` (default-on in `local_trusted`, default-off in `authenticated`).
- **Branding** — logo upload via `company_logos` → `assets`. `brandColor` drives sidebar / favicon / banner.
- **Org chart** — SVG/PNG render of reporting hierarchy (`/api/companies/{co}/org-chart/{svg|png}?style=…`). Five styles: `monochrome`, `nebula`, `circuit`, `warmth`, `schematic`.
- **Members** — `company_memberships` (active / inactive). Board adds/removes members; users have an inferred role per membership.
- **Permissions** — fine-grained capability grants in `principal_permission_grants`: `principalType ∈ {user, agent}`, `permissionKey` (e.g., `agents:create`, `tasks:assign`), optional `scope` JSONB.
- **Portability** — `POST /companies/{co}/export` produces a portable bundle. `POST /companies/{co}/imports/preview` and `…/apply` import; `new_company` mode safely copies active memberships, scrubs secrets, and resolves collisions.

### 3.2 Schema (companies)

`packages/db/src/schema/companies.ts`:
```
id, name, description, status, pauseReason, pausedAt,
issuePrefix (e.g., "SYL"), issueCounter (auto-increment for SYL-1, SYL-2, …),
budgetMonthlyCents, spentMonthlyCents,
requireBoardApprovalForNewAgents, brandColor,
createdAt, updatedAt
```

Supporting tables: `company_logos`, `company_memberships`, `instance_user_roles`, `principal_permission_grants`.

### 3.3 Notable behaviors

- Issue identifiers are auto-assigned per company: `${issuePrefix}-${issueCounter++}`.
- Logo upload reuses the asset/storage layer (`server/src/storage/`) — local disk by default, pluggable to S3/etc. via `paperclipai configure --section storage`.
- The org chart endpoint can render PNG via headless rasterization; the SVG is also consumed by `ui/src/pages/OrgChart.tsx` for an interactive in-app view.

---

## 4. Agents

### 4.1 Adapter Catalog

Each runtime has a dedicated adapter package under `packages/adapters/`:

| Adapter | Auth model | Notes |
|---|---|---|
| `claude_local` | Spawns `claude` CLI; uses CLI's OAuth login. | Optional `dangerouslySkipPermissions` to bypass tool sandbox. Skills mounted in Claude home. |
| `codex_local` | Spawns `codex` CLI. Per-company codex-home symlinks `auth.json` from `$CODEX_HOME` / `~/.codex`. | Quota polling via short-lived `codex app-server`; failures non-fatal to server. |
| `cursor_local` | Spawns Cursor CLI. | Default model via `DEFAULT_CURSOR_LOCAL_MODEL`. |
| `gemini_local` | Spawns `gemini` CLI; injects skills as symlinks into `~/.gemini/skills/` so CLI finds OAuth in `~/.gemini`. | Auto-detects `subscription` (OAuth) vs `api` (`GEMINI_API_KEY` / `GOOGLE_API_KEY`) billing mode. Reports `gemini_auth_required` errorCode on missing auth. |
| `opencode_local` | OpenCode integration. | Pre-flight model availability check. |
| `pi_local` | Pi integration. | |
| `openclaw_gateway` | Webhook-driven heartbeats over HTTP. | Used for OpenClaw-style external agents that pull work from the API. |

### 4.2 Lifecycle

`hire` → (optional) `pending_approval` → `active` → (`pause` ↔ `resume`) → `terminated`.

- **Hire**: `POST /companies/{co}/agent-hires` creates an `approvals` row of type `hire_agent` if `requireBoardApprovalForNewAgents=true`. Hire payloads are normalized in `services/approvals.ts` with secret redaction before persistence.
- **Pause/Resume**: `POST /agents/{id}/pause` (sets `pauseReason`+`pausedAt`); `…/resume` clears them. Budget hard-stop also pauses.
- **Wakeup**: `POST /agents/{id}/wakeup` enqueues an `agent_wakeup_requests` row with idempotency-aware coalescing.

### 4.3 Per-agent fields

`packages/db/src/schema/agents.ts`:
```
id, companyId, name, urlKey, role (ceo|general|custom), title, icon,
status, reportsTo, capabilities,
adapterType, adapterConfig (JSONB),
runtimeConfig: { heartbeat: { enabled, cooldownSec, intervalSec, wakeOnDemand, maxConcurrentRuns } },
budgetMonthlyCents, spentMonthlyCents,
permissions (JSONB; e.g., {canCreateAgents: true}),
pauseReason, pausedAt, lastHeartbeatAt, metadata,
createdAt, updatedAt
```

### 4.4 Instructions Bundle

Each agent has an instructions tree at:
```
~/.paperclip/instances/<id>/companies/<co>/agents/<agent>/instructions/
```
- `instructionsEntryFile` defaults to `AGENTS.md`.
- `instructionsBundleMode` is `managed` (Paperclip-owned) or external (synced from a local path via `POST /agents/{id}/instructions/sync`).
- `instructionsRootPath` is the canonical source of truth handed to the adapter at run time.

### 4.5 Auth & State

- **API keys** in `agent_api_keys` (hashed; `keyId`, `agentId`, `companyId`, expiry).
- **Per-run JWT**: `createLocalAgentJwt(agent, run)` mints a token tied to a single run; injected as `PAPERCLIP_API_KEY` only if the JWT secret exists (run `pnpm paperclipai onboard` to create it). Without it, the dev banner shows **"Agent JWT missing"** and adapters skip the env injection.
- **Runtime state**: `agent_runtime_state` (resumable snapshots), `agent_task_sessions` (per-task session continuity), `agent_config_revisions` (immutable config history), `agent_wakeup_requests`.

### 4.6 Per-Agent Sandbox Configuration

Adapters that wrap a sandboxed CLI (notably `claude_local`) inherit settings from the workspace dir. The board operator can drop a `.claude/settings.json` into the agent's workspace to allowlist tools (`Bash(curl:*)`, `Write`, etc.) without granting blanket permissions. The adapter also exposes `dangerouslySkipPermissions: true` for trusted local-only contexts.

---

## 5. Skills

### 5.1 What a Skill is

A markdown-driven capability bundle that an agent can use at runtime. Each skill belongs to a company and is delivered to the agent via adapter-specific home injection.

### 5.2 Capabilities

- Create (markdown body + optional file inventory).
- Read & list — metadata + `fileInventory[]`.
- Read file — `GET /companies/{co}/skills/{id}/files?path=…`.
- Update file — `PATCH /companies/{co}/skills/{id}/files`.
- Import — bulk import from URL/registry/git source.
- Scan projects — auto-discover skills in project workspaces (`POST /companies/{co}/skills/scan-projects`).
- Install update — apply upstream changes when source has newer version.
- Delete — soft- or hard-delete.

### 5.3 Schema

`company_skills`:
```
id, companyId, key, slug, name, description, markdown,
sourceType (local|url|registry|git),
sourceLocator, sourceRef,
trustLevel (markdown_only|full),
compatibility, fileInventory (JSONB),
metadata, createdAt, updatedAt
```

### 5.4 Adapter Injection

| Adapter | Mount point |
|---|---|
| `claude_local` | Per-company Claude home, skills listed under standard skills dir. |
| `codex_local` | `~/.paperclip/instances/<id>/companies/<co>/codex-home/` (symlinked from `~/.codex`). |
| `gemini_local` | Symlinks into `~/.gemini/skills/` (so CLI finds OAuth & skills together). |

### 5.5 Trust Levels

- `markdown_only`: documentation-only; no executable scripts. Default for imported skills.
- `full`: may include executable helpers; requires explicit operator opt-in. Applies to scanned/maintainer-authored skills.

### 5.6 Public Skill Surface

For agent onboarding handoff:
- `GET /api/skills/index` — list of all available skills.
- `GET /api/skills/paperclip` — the canonical "how to be a Paperclip agent" skill markdown.

---

## 6. Tasks (Issues)

### 6.1 Lifecycle & Status

Six-state machine:
```
backlog → todo → in_progress → in_review → blocked → done
                                                     ↘ cancelled
```
Auto-stamps:
- `startedAt` on first transition to `in_progress`
- `completedAt` on `done`
- `cancelledAt` on `cancelled`

Soft-hide via `hiddenAt`. Priority `low|medium|high` (default `medium`).

### 6.2 Atomic Single-Assignee Checkout

`services/issues.ts:1199` `checkout(issueId, agentId, runId)`:
- Conditional UPDATE succeeds **only if** the issue is currently:
  - unassigned, OR
  - assigned to `agentId` already, OR
  - locked by the same `executionRunId` re-entering.
- Sets `status='in_progress'`, `executionRunId`, `executionLockedAt`, `executionAgentNameKey`.
- Returns 409 to losers in the race.

`release(issueId)` clears the lock without changing status.

### 6.3 Schema (issues)

`packages/db/src/schema/issues.ts`:
```
id, companyId, identifier (e.g., "SYL-12"), issueNumber,
title, body, priority, status, hiddenAt,
parentId (self-FK), goalId (FK goals), projectWorkspaceId,
assigneeAgentId, assigneeUserId, assigneeAdapterOverrides (JSONB),
checkoutRunId, executionRunId, executionWorkspaceId,
executionWorkspacePreference, executionWorkspaceSettings (JSONB),
executionAgentNameKey, executionLockedAt,
billingCode,
originKind (manual|routine_execution|...), originId, originRunId,
requestDepth,
startedAt, completedAt, cancelledAt,
createdAt, updatedAt
```

### 6.4 Comments

`issue_comments`:
- `body` (markdown), `authorAgentId` / `authorUserId`, timestamps.
- Pagination cap: 500 per request.
- Optimistic UI: client queues comments while offline, syncs on reconnect.
- @mentions surface in the inbox.

### 6.5 Attachments

`issue_attachments` ↔ `assets`:
- `POST /companies/{co}/issues/{id}/attachments` (multipart, max 1 file per request).
- Optional `issueCommentId` for inline-in-comment.
- `GET /attachments/{id}/content` streams content with managed lifecycle.

### 6.6 Labels

- `labels` per company (name + color).
- `issue_labels` m:n.
- `POST/DELETE /companies/{co}/labels` and link/unlink to issue.

### 6.7 Work Products

`issue_work_products`:
```
type, provider, externalId,
status, reviewState (pending|approved|rejected),
healthStatus (unknown|healthy|degraded|failed),
isPrimary, summary, externalUrl, metadata (JSONB),
createdByRunId
```

Used to track structured deliverables — PRs, deploys, dashboards, exported docs — produced by an agent against an issue.

### 6.8 Documents

- `issue_documents` references a `documents` row.
- `documents` has `document_revisions` for history.
- `PUT /issues/{id}/documents/{key}` upserts; `GET /…/revisions` lists history; `DELETE /…/{key}` removes.
- Used for structured outputs (e.g., briefs, plans, generated reports) keyed by stable `key`.

### 6.9 Read States & Inbox Archive

- `issue_read_states` per user (`lastReadAt`).
- `issue_inbox_archives` for soft-archiving from the operator's inbox.
- Endpoints: `POST /issues/{id}/read`, `…/inbox-archive` and unarchive variants.

### 6.10 Approvals

- `issue_approvals` junction table; many-to-many between `issues` and `approvals`.
- `linkedByAgentId` / `linkedByUserId` audit trail.
- `GET /issues/{id}/approvals`, `POST` to link, `DELETE` to unlink.

### 6.11 API Endpoints (issues)

```
POST   /api/companies/{co}/issues
GET    /api/companies/{co}/issues
GET    /api/issues/{id}
PATCH  /api/issues/{id}
DELETE /api/issues/{id}
POST   /api/issues/{id}/checkout
POST   /api/issues/{id}/release
GET    /api/issues/{id}/heartbeat-context
GET/POST/DELETE /api/issues/{id}/comments[/{commentId}]
GET/POST /api/issues/{id}/approvals
POST/DELETE /api/issues/{id}/read
POST/DELETE /api/issues/{id}/inbox-archive
GET/POST/PATCH/DELETE /api/issues/{id}/documents[/{key}]
GET/POST/PATCH/DELETE /api/issues/{id}/work-products[/{wpId}]
POST/GET/DELETE /api/companies/{co}/issues/{id}/attachments[/{attId}]
GET    /api/issues/{id}/activity
GET    /api/issues/{id}/runs
```

---

## 7. Projects & Execution Workspaces

### 7.1 Projects

`packages/db/src/schema/projects.ts`:
```
id, companyId, name, description, status, color,
leadAgentId, targetDate, archivedAt,
pausedAt, pauseReason,
executionWorkspacePolicy (JSONB),
createdAt, updatedAt
```

Status set parallels issues. `executionWorkspacePolicy` parsed by `services/execution-workspace-policy.ts` and controls provisioning strategy, reuse rules, and cleanup.

### 7.2 Project Workspaces (Repos)

`project_workspaces`:
```
id, projectId,
sourceType (local_path|git|...),
repoUrl, repoRef, defaultRef, cwd,
setupCommand, cleanupCommand,
remoteProvider, remoteWorkspaceRef,
sharedWorkspaceKey (for pooling),
isPrimary, metadata (JSONB)
```

### 7.3 Execution Workspaces

Per-run isolated workspaces — `execution_workspaces`. They hold:
- Working directory provisioning (clone, worktree, or shared-pool reuse).
- Branch/ref tracking.
- Environment variable injection.
- Provision/teardown command execution.
- Linkage back to `issues.executionWorkspaceId`.

### 7.4 Runtime Services

`workspace_runtime_services` — long-running side processes (dev servers, watchers, listeners) keyed by intent. Each has `intentsJson` describing what it provides; the workspace runtime (`services/workspace-runtime.ts`) starts/stops them lazily.

### 7.5 Workspace Operations Audit

`workspace_operations` + `workspace_operation_log_store` capture every setup/teardown/clone/branch action with structured logs — useful for debugging stuck provisions.

### 7.6 Worktree-Local Instances

For developing across multiple git worktrees:
```sh
pnpm paperclipai worktree init        # repo-local config + isolated instance
pnpm paperclipai worktree:make NAME   # git worktree add + init in one step
pnpm paperclipai worktree env         # shell exports
```
- Repo-local config lives at `.paperclip/config.json` and `.paperclip/.env`.
- Isolated instance under `~/.paperclip-worktrees/instances/<id>/`.
- Free server + DB ports auto-picked.
- Seeds via `--seed-mode minimal|full|--no-seed`.
- Sets `PAPERCLIP_IN_WORKTREE=true`, `PAPERCLIP_WORKTREE_NAME`, `PAPERCLIP_WORKTREE_COLOR` for UI branding.

### 7.7 API Endpoints (projects/workspaces)

```
GET/POST/PATCH/DELETE /api/companies/{co}/projects[/{id}]
GET/POST/PATCH /api/projects/{id}/workspaces[/{wsId}]
GET/PATCH /api/execution-workspaces/{id}
POST /api/execution-workspaces/{id}/close
```

---

## 8. Goals

### 8.1 Hierarchy

`goals`:
```
id, companyId, parentId (self-FK),
title, description,
level (task|milestone|roadmap),
ownerAgentId, status (planned|...),
createdAt, updatedAt
```

### 8.2 Linkage

- `project_goals` — m:n link between projects and goals (one project can advance multiple goals; one goal can be served by multiple projects).
- `issues.goalId` — direct issue→goal alignment.

### 8.3 Goal-Aware Execution

`services/issue-goal-fallback.ts` walks the parent chain from an issue's project / parent issue when `issues.goalId` is null, so every agent run sees the **why** in its heartbeat context. This is the foundation of "Goal-aware execution."

### 8.4 API Endpoints (goals)

```
GET/POST /api/companies/{co}/goals
GET/PATCH/DELETE /api/goals/{id}
```

---

## 9. Routines (Scheduled Work)

### 9.1 Concept

A `routine` is a recurring work definition. Each tick either creates a new linked issue (with `originKind=routine_execution`) or coalesces into an active run.

### 9.2 Schema

`routines`:
```
id, companyId, projectId, goalId, parentIssueId,
title, description,
assigneeAgentId (mandatory),
priority,
status (active|paused|archived),
concurrencyPolicy (coalesce_if_active|skip_if_active|always_enqueue),
catchUpPolicy (skip_missed|enqueue_missed_with_cap),
lastTriggeredAt, lastEnqueuedAt
```

`routine_triggers`:
```
id, routineId,
kind (cron|webhook|manual),
label, enabled,
cronExpression, timezone, nextRunAt, lastFiredAt,
publicId (for webhooks), secretId, signingMode, replayWindowSec,
lastResult
```

`routine_runs`:
```
id, routineId, triggerId,
source (cron|webhook|manual|api),
status (received|queued|running|completed|failed),
triggeredAt, idempotencyKey, triggerPayload,
linkedIssueId, coalescedIntoRunId,
failureReason, completedAt
```

### 9.3 Concurrency & Catch-Up Policies

`services/routines.ts`:

| Policy | Behavior |
|---|---|
| `coalesce_if_active` | If a run is in flight, merge the new fire into it (increment `coalescedCount`). |
| `skip_if_active` | Drop the new fire entirely. |
| `always_enqueue` | Always create a new run; concurrency is the assignee agent's problem. |
| `skip_missed` | After downtime, ignore missed fires. (default) |
| `enqueue_missed_with_cap` | Enqueue up to 25 missed fires. |

### 9.4 Webhook Triggers

- HMAC-signed via `secretId` (a `company_secrets` ref).
- Replay protection via `replayWindowSec`.
- Public endpoint: `POST /api/routine-triggers/public/{publicId}/fire` — no auth, just signature.
- Operator can `POST /api/routine-triggers/{id}/rotate-secret` to rotate the signing key.

### 9.5 API Endpoints (routines)

```
GET/POST /api/companies/{co}/routines
GET/PATCH /api/routines/{id}
GET /api/routines/{id}/runs
POST /api/routines/{id}/run                     # manual fire
POST /api/routines/{id}/triggers
PATCH/DELETE /api/routine-triggers/{id}
POST /api/routine-triggers/{id}/rotate-secret
POST /api/routine-triggers/public/{publicId}/fire
```

---

## 10. Heartbeat & Wake System

### 10.1 Heartbeat Runs

`heartbeat_runs`:
```
id, companyId, agentId,
invocationSource (cron|on_demand),
triggerDetail,
status (queued|running|succeeded|failed),
startedAt, finishedAt,
exitCode, signal,
wakeupRequestId,
sessionIdBefore, sessionIdAfter,
processPid, processStartedAt,
retryOfRunId, processLossRetryCount,
logStore, logRef, logBytes, logSha256, logCompressed,
stdoutExcerpt, stderrExcerpt, errorCode,
externalRunId,
contextSnapshot (JSONB),
usageJson (JSONB; tokens, cache, model, billingType, costUsd),
resultJson (JSONB),
createdAt, updatedAt
```

### 10.2 Run Events

`heartbeat_run_events` — typed event stream:
```
runId, seq (monotonic),
eventType (thinking_start|tool_call|message|adapter.invoke|...),
stream (system|stdout|stderr|...),
level (info|warning|error),
color, message,
payload (JSONB)
```
Used by the UI to render a faithful transcript.

### 10.3 Process-Loss Recovery

`processPid` + `processStartedAt` are reconciled against the OS. Orphaned runs are marked failed and `retryOfRunId` chains the recovery attempt; `processLossRetryCount` caps retries.

### 10.4 Env Injected Into Agent Process

When an adapter spawns an agent, Paperclip injects (subset varies by source kind):
```
PAPERCLIP_API_URL          # http://127.0.0.1:3100
PAPERCLIP_API_KEY          # per-run JWT (if onboard secret exists)
PAPERCLIP_RUN_ID
PAPERCLIP_TASK_ID          # the issue, if any
PAPERCLIP_WAKE_REASON      # "manual" | "cron" | "task_assigned" | ...
PAPERCLIP_WAKE_COMMENT_ID
PAPERCLIP_APPROVAL_ID
PAPERCLIP_APPROVAL_STATUS
PAPERCLIP_LINKED_ISSUE_IDS
PAPERCLIP_WORKSPACE_CWD
PAPERCLIP_WORKSPACE_SOURCE
PAPERCLIP_WORKSPACE_STRATEGY
PAPERCLIP_WORKSPACE_ID
PAPERCLIP_WORKSPACE_REPO_URL
PAPERCLIP_WORKSPACE_REPO_REF
PAPERCLIP_WORKSPACE_BRANCH
PAPERCLIP_WORKSPACE_WORKTREE_PATH
PAPERCLIP_WORKSPACES_JSON
PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON
PAPERCLIP_RUNTIME_SERVICES_JSON
PAPERCLIP_RUNTIME_PRIMARY_URL
```

### 10.5 Wakeup Requests

`agent_wakeup_requests`:
```
id, companyId, agentId,
status (queued|claimed|finished),
reason, payload (JSONB),
idempotencyKey, coalescedCount,
requestedAt, claimedAt, finishedAt
```

Coalescing prevents duplicate work when multiple triggers fire close together.

---

## 11. Approvals & Governance

### 11.1 Approval Lifecycle

```
pending → approved
        → rejected
        → revision_requested → (back to requester) → pending
                                                   → resolved
```

`approvals`:
```
id, companyId, type (hire_agent|...),
status, requestedByAgentId, requestedByUserId,
decidedByUserId, decidedAt, decisionNote,
payload (JSONB; secrets scrubbed on persist)
```

### 11.2 Built-In Types

| Type | Trigger | Notes |
|---|---|---|
| `hire_agent` | Agent creation when `requireBoardApprovalForNewAgents=true`. | Payload normalized; secrets scrubbed. Post-approval hook `notifyHireApproved` finalizes hire. |

The type system is extensible — services can register new types and resolution hooks.

### 11.3 Comments & Issue Linkage

- `approval_comments` — threaded discussion on a request.
- `issue_approvals` — m:n between approvals and issues. Issues can require an approval before completion; approval flow can reference work-in-progress issues.

### 11.4 API Endpoints (approvals)

```
GET/POST /api/companies/{co}/approvals
GET /api/approvals/{id}
PATCH /api/approvals/{id}                # approve/reject/request-revision
GET/POST /api/approvals/{id}/comments
GET /api/approvals/{id}/issues
POST/DELETE /api/issues/{id}/approvals
```

---

## 12. Costs, Budgets & Finance

### 12.1 Cost Events

`cost_events` — append-only:
```
id, companyId, agentId,
issueId, projectId, goalId, heartbeatRunId,
provider (anthropic|openai|google|...),
biller (subscription_included|api|...),
model,
inputTokens, cachedInputTokens, outputTokens,
costCents,
occurredAt, createdAt
```
Agents can report own costs; board can report any. Attribution lets aggregations slice by project, goal, agent, model, etc.

### 12.2 Budget Policies

`budget_policies`:
```
scopeType (company|agent|project), scopeId,
metric (billed_cents|input_tokens),
windowKind (calendar_month_utc|lifetime),
amount,
warnPercent (e.g., 80),
hardStopEnabled, notifyEnabled,
isActive,
createdByUserId, updatedByUserId
```

### 12.3 Budget Incidents & Hard-Stop

`budget_incidents`:
```
status (triggered|escalated|resolved),
observedAmount, threshold,
resolutionAction
```

When `hardStopEnabled=true` and threshold is crossed:
- `services/heartbeat.ts → cancelBudgetScopeWork(scope)` is invoked.
- All in-flight runs for the scope are cancelled.
- The scope (company/agent/project) is paused.
- An incident row is created and logged via `activity_log`.

The board resolves an incident via `POST /companies/{co}/budget-incidents/{id}/resolve` with `resolutionAction`.

### 12.4 Quota Windows

`services/quota-windows.ts` tracks **provider-level** quotas (Anthropic, OpenAI, Google) — distinct from internal budgets. Pre-empts overage by reading provider quota state and surfacing it on the cost dashboard.

### 12.5 Finance Events

`finance_events` — board-only revenue/refund tracking:
```
eventKind (payment|refund|adjustment|other),
direction (inbound|outbound),
biller, amountCents, occurredAt
```

### 12.6 Aggregations

```
GET /api/companies/{co}/costs/summary
GET /api/companies/{co}/costs/by-agent
GET /api/companies/{co}/costs/by-agent-model
GET /api/companies/{co}/costs/by-provider
GET /api/companies/{co}/costs/by-biller
GET /api/companies/{co}/costs/by-project
GET /api/companies/{co}/costs/finance-summary
GET /api/companies/{co}/costs/finance-by-kind
GET /api/companies/{co}/costs/finance-events
GET /api/companies/{co}/costs/window-spend
GET /api/companies/{co}/costs/quota-windows
```

### 12.7 API Endpoints (budgets/finance)

```
POST /api/companies/{co}/cost-events
POST /api/companies/{co}/finance-events     # board only
GET /api/companies/{co}/budgets/overview
POST /api/companies/{co}/budgets/policies
PATCH /api/companies/{co}/budgets
PATCH /api/agents/{id}/budgets
POST /api/companies/{co}/budget-incidents/{id}/resolve
```

---

## 13. Activity / Audit Log

### 13.1 Schema

`activity_log` (immutable):
```
id, companyId,
actorType (agent|user|system), actorId,
action (string; namespaced e.g., "company.created", "issue.checked_out"),
entityType, entityId,
agentId, runId,
details (JSONB; sensitive values redacted),
createdAt
```

### 13.2 Behavior

- Every mutating endpoint calls `logActivity(...)`. Append-only; no UPDATE/DELETE.
- `runId` correlates to `heartbeat_runs` so any action taken during an agent run is recoverable.
- `details` is filtered by `server/src/log-redaction.ts` before write.

### 13.3 Surfaces

- Per-entity: `GET /issues/{id}/activity`.
- Per-run: `GET /heartbeat-runs/{id}` includes activity context.
- Company-wide: `GET /companies/{co}/activity?agentId=&entityType=&entityId=…`.

---

## 14. User Dashboard

### 14.1 Route

`/[COMPANY-PREFIX]/dashboard` — `ui/src/pages/Dashboard.tsx`.

### 14.2 Widgets

| Widget | Source | Notes |
|---|---|---|
| Live agent metrics | `agentsApi.list()` | Active / errored / paused counts. |
| `RunActivityChart` | `heartbeatsApi.liveRunsForCompany()` | 5-second refetch. |
| `PriorityChart` | `issuesApi.list()` | Distribution by `priority`. |
| `IssueStatusChart` | `issuesApi.list()` | Distribution by `status`. |
| `SuccessRateChart` | `dashboardApi`, `heartbeatsApi` | Per-agent success ratio. |
| `ActiveAgentsPanel` | `agentsApi.list()` + live runs | Currently-running with status indicators. |
| Recent activity feed | `activityApi.list()` | `ActivityRow` items. |
| Recent issues | `issuesApi.list({orderBy:'updatedAt'})` | Last-modified first. |

### 14.3 Behaviors

- Live updates: subscribes to `LiveUpdatesProvider` for instant cache invalidation on relevant events.
- Click-through: every chart segment navigates to a filtered list view.

---

## 15. User Inbox

### 15.1 Route

`/[COMPANY]/inbox/{mine,recent,unread,all}` — `ui/src/pages/Inbox.tsx`.

Backend: `/api/agents/me/inbox-lite` and `/api/sidebar-badges/*`.

### 15.2 Tabs

| Tab | Filter |
|---|---|
| `mine` | Issues assigned to or touched by current operator (`INBOX_MINE_ISSUE_STATUS_FILTER` defines the cutoff statuses). |
| `recent` | All recently updated issues across the company. |
| `unread` | Items not yet read (per `issue_read_states`). |
| `all` | Everything in the company inbox surface. |

### 15.3 Sub-Sections (per tab)

| Section | Source |
|---|---|
| Work items | Issues assigned to operator / agent. |
| Issues I touched | Issues where operator authored a comment / change. |
| Join requests | `join_requests` pending — inline approve/reject. |
| Approvals | `approvals` filtered by status (pending/all). |
| Failed runs | `heartbeat_runs` with `status='failed'`, grouped by agent. |
| Alerts | Budget incidents, system policy notifications. |

### 15.4 Interactions

- **Swipe-to-archive** (`SwipeToArchive` component) — writes `issue_inbox_archives`.
- **Read/unread management** via `useReadInboxItems`, `useDismissedInboxItems`.
- **Sidebar badges** computed by `services/sidebar-badges.ts` and consumed by `useInboxBadge`.
- **Inline approval response** — approve/reject without leaving inbox.
- **Click-through** — opens issue/approval/run detail.

### 15.5 Why this surface exists

Without an inbox, an operator can't tell at a glance what needs them. The inbox aggregates *every* form of "you should look" signal — assigned work, mentions, approvals, failures, alerts — into one swipeable feed.

---

## 16. Settings (Company + Instance)

### 16.1 Company Settings

Route: `/[CO]/company/settings` — `ui/src/pages/CompanySettings.tsx`.

| Section | Capability |
|---|---|
| **General** | Name, description, brand color, logo upload. |
| **Members & Roles** | List members; invite/remove; manage `principal_permission_grants`. |
| **Integration Snippets** | Invite URLs and API embed snippets. |
| **Danger Zone** | Export, archive, delete (subject to `PAPERCLIP_ENABLE_COMPANY_DELETION`). |

### 16.2 Company Export / Import

- `/[CO]/company/export/*` — `CompanyExport.tsx`. Produces a portable bundle (agents, projects, issues, skills, settings — secrets scrubbed).
- `/[CO]/company/import` — `CompanyImport.tsx`. Two-step: preview → apply. `new_company` mode safely populates a fresh company with collision handling.

### 16.3 Skills Manager

Route: `/[CO]/skills/*` — `ui/src/pages/CompanySkills.tsx`.
- List with version + source badges.
- File-tree viewer for skill contents.
- Markdown editor for descriptions.
- Scan-projects button for auto-discovery.
- Create / edit / delete forms.
- Status indicators (active, deprecated, in-progress).

### 16.4 Instance Settings (Admin)

| Route | Page |
|---|---|
| `/instance/settings/general` | `InstanceGeneralSettings.tsx` — log-redaction toggles, multi-tenant host config. |
| `/instance/settings/heartbeats` | `InstanceSettings.tsx` — heartbeat scheduler config. |
| `/instance/settings/experimental` | `InstanceExperimentalSettings.tsx` — feature flags including guarded auto-restart. |

### 16.5 Secrets

Backend: `/api/companies/{co}/secrets`, `/api/secrets/{id}*`.

| Field | Notes |
|---|---|
| `provider` | `local_encrypted`, AWS Secrets Manager, Vault, etc. (configurable via `paperclipai configure --section secrets`). |
| `externalRef` | For AWS/Vault — opaque reference. |
| `latestVersion` | Integer; bumped on every rotation. |

`company_secret_versions` retains version history. **Secrets are never returned in plaintext** through the API — only metadata. Strict mode (`PAPERCLIP_SECRETS_STRICT_MODE=true`) requires that any `*_API_KEY` / `*_TOKEN` / `*_SECRET` env value on an agent be a secret reference, not an inline literal. Migrate existing inline values via `pnpm secrets:migrate-inline-env --apply`.

### 16.6 Routines

Route: `/[CO]/routines[/:id]` — `Routines.tsx`, `RoutineDetail.tsx`. See §9.

### 16.7 Permissions

`principal_permission_grants` keyed by `permissionKey` (`agents:create`, `tasks:assign`, …) with optional `scope` JSONB to narrow grants (e.g., to a specific project).

---

## 17. Plugins & Extensibility

### 17.1 Plugin System

Plugins are npm packages discovered, installed, and managed via:
- `/instance/settings/plugins` — `PluginManager.tsx`
- `/instance/settings/plugins/:id` — `PluginSettings.tsx`
- Per-company plugin pages: `/[CO]/:pluginRoutePath` — `PluginPage.tsx`

### 17.2 Plugin Lifecycle

`server/src/services/plugin-*`:
- **Loader** discovers from `DEFAULT_LOCAL_PLUGIN_DIR` and registry.
- **Lifecycle manager** transitions plugins through `installed → enabled → ready → error`.
- **Worker manager** spawns sandboxed Node workers (`plugin-runtime-sandbox`).
- **Host services** (`plugin-host-services`) expose Paperclip APIs to plugins through a permissioned shim.
- **Event bus** (`plugin-event-bus`) routes `activity_log` and lifecycle events.
- **Tool dispatcher** registers plugin-provided tools for agents.
- **Job coordinator + scheduler + store** run scheduled plugin jobs.
- **Log retention** trims `plugin_logs`.
- **Dev watcher** hot-reloads plugins from a local source dir.

### 17.3 Plugin Capability Model

`plugin-capability-validator.ts` and `plugin-config-validator.ts` gate what plugins can do via declared capabilities, sandboxed I/O, and a permission model parallel to Paperclip's own.

### 17.4 Plugin Schema

```
plugins, plugin_config, plugin_state,
plugin_jobs, plugin_logs, plugin_entities,
plugin_webhooks, plugin_company_settings
```

### 17.5 Plugin UI Extensibility

- **Sidebar slots** — plugins can add nav entries.
- **Custom pages** — plugins render under `/[CO]/:pluginRoutePath` via `PluginPage.tsx`.
- **Plugin-specific config UIs** — rendered at `/instance/settings/plugins/:id`.

---

## 18. Realtime, Notifications & Mobile

### 18.1 Live Updates

- **Endpoint**: `/api/live-updates` (WebSocket/SSE).
- **Provider**: `ui/src/context/LiveUpdatesProvider.tsx`.
- **Events**: agent status changes, issue updates, approvals, run completions, budget alerts.
- **Behavior**: toast notifications in bottom-right (`ToastViewport`); React Query cache invalidation for affected resources.

### 18.2 Sidebar Badges

Computed by `server/src/services/sidebar-badges.ts`. Consumed by `useInboxBadge`. Surfaces unread inbox items, live run counts, failed runs, pending approvals.

### 18.3 Mobile

- `MobileBottomNav.tsx` replaces sidebar on small screens.
- `Agents.tsx` and `Issues.tsx` force list view on mobile.
- Whole UI is touch-friendly; product positions itself as **manageable from your phone**.

### 18.4 Multi-Company Switcher

`CompanyRail.tsx` — vertical rail of company logos, drag-to-reorder, persisted to localStorage. Backed by `companiesApi.list()`.

A standalone `/companies` page (`Companies.tsx`) provides a tabular multi-company list with stats, inline rename, and delete — used when the rail isn't enough or before a company is selected.

### 18.5 Personal Issue Slice

`/[CO]/my-issues` — `MyIssues.tsx`. Operator's personal slice of assigned-to-me issues, separate from Inbox (which aggregates many signals). Same item shape as Issues but pre-filtered to the operator.

### 18.5 Command Palette

`CommandPalette.tsx` — Cmd+K global search & action launcher.

---

## 19. Authentication, Invites & Onboarding

### 19.1 Sign-In

- `/auth` — `Auth.tsx`. Better-auth-backed sign-in/sign-up. Redirects on success.
- `local_trusted` mode bypasses auth entirely (single implicit operator).

### 19.2 Invites

- `/invite/:token` — `InviteLanding.tsx`. Public landing.
- API:
  - `GET /api/invites/{token}` — invite summary.
  - `GET /api/invites/{token}/onboarding` — onboarding manifest (registration endpoint, claim endpoint template, skill install hints).
  - `GET /api/invites/{token}/onboarding.txt` — plain-text llm.txt-style handoff for both humans and agents.
- Agent join: `adapterType=openclaw` flow validated by `pnpm smoke:openclaw-join`.

### 19.3 Board Claim

`/board-claim/:token` — `BoardClaim.tsx`. Token-based first-board-operator setup for fresh deployments.

### 19.4 CLI Auth

`/cli-auth/:id` — `CliAuth.tsx`. Out-of-band auth handshake for `paperclipai` CLI; backed by `cli_auth_challenges`.

### 19.5 Onboarding Wizard

`OnboardingWizard` modal + `OnboardingRoutePage` — first-company / first-agent setup. Idempotent: rerunning `paperclipai onboard` keeps existing config in place.

### 19.6 Bootstrap Status

Surfaced in `/api/health`:
```json
{
  "status": "ok",
  "version": "0.3.1",
  "deploymentMode": "local_trusted",
  "deploymentExposure": "private",
  "authReady": true,
  "bootstrapStatus": "ready",
  "bootstrapInviteActive": false,
  "features": { "companyDeletionEnabled": true }
}
```

---

## 20. Non-Functional Requirements

### 20.1 Self-contained

- **Zero cloud dependency on Paperclip's side.** No telemetry, no license check, no SaaS account.
- All outbound calls are agent-driven (LLM provider, OAuth login, optional plugin webhooks).

### 20.2 Storage & DB

| Concern | Default | Override |
|---|---|---|
| Database | Embedded Postgres @ `~/.paperclip/instances/<id>/db` | `DATABASE_URL` for external. Migrations: 46 at v0.3.1. |
| Storage | Local disk @ `~/.paperclip/instances/<id>/data/storage` | `paperclipai configure --section storage`. |
| Secrets | `local_encrypted` w/ key file @ `~/.paperclip/instances/<id>/secrets/master.key` | `PAPERCLIP_SECRETS_PROVIDER`, `PAPERCLIP_SECRETS_STRICT_MODE`, `PAPERCLIP_SECRETS_MASTER_KEY[_FILE]`. |
| Backups | Enabled, 60-min interval, 30-day retention @ `~/.paperclip/instances/<id>/data/backups` | `PAPERCLIP_DB_BACKUP_*` env vars. |

### 20.3 Migrations

Drizzle ORM. `drizzle.config.ts` reads compiled schema from `packages/db/dist/schema/*.js`, so `pnpm db:generate` builds `packages/db` first.

### 20.4 Auth-at-rest

- Agent API keys hashed; plaintext returned **once** at issue/claim.
- Secrets versioned; never returned plaintext via API.
- Agent JWT secret created during `paperclipai onboard`; missing secret surfaces in dev banner.

### 20.5 Observability

- Structured pino logging with HTTP middleware (`server/src/middleware/logger.ts`, `httpLogger`).
- Log redaction (`log-redaction.ts`, `redaction.ts`) before any persistence.
- Heartbeat run events captured per `seq` for transcript reconstruction.

### 20.6 Multi-tenancy

- Every entity company-scoped.
- Access guards in routes **and** services (defense in depth).
- Agent API keys cannot cross companies.

### 20.7 Process & Performance

- Idempotent dev runner: `pnpm dev` reuses an existing process for the same repo + instance.
- Plugin job scheduler ticks every 30 s with `maxConcurrentJobs=10`.
- Heartbeat default cadence: `intervalSec=3600` (1 h) + `wakeOnDemand=true` + `cooldownSec=10`.

### 20.8 Reliability

- Atomic checkout prevents double-execution.
- Process-loss retry (`processLossRetryCount`) with bound.
- Coalescing on wakeup requests prevents duplicate fires.
- Hard-stop forces budget compliance even mid-run.

### 20.9 PR & Contribution Norms

(From `CONTRIBUTING.md`.)
- Small PRs auto-merge; large PRs require Discord #dev pre-discussion + screenshots + thinking-path description.
- PR descriptions open with a top-down "thinking path" rationale.

---

## 21. Appendix A — REST API Surface

All routes prefixed with `/api`. Companion routes accept board sessions or agent bearer tokens unless noted.

### 21.1 Health & Bootstrap
```
GET  /api/health
```

### 21.2 Companies
```
GET    /api/companies
POST   /api/companies
GET    /api/companies/{co}
PATCH  /api/companies/{co}
PATCH  /api/companies/{co}/branding          # CEO agent allowed
POST   /api/companies/{co}/archive
DELETE /api/companies/{co}
GET    /api/companies/stats
POST   /api/companies/{co}/export
POST   /api/companies/{co}/imports/preview
POST   /api/companies/{co}/imports/apply
GET    /api/companies/{co}/org-chart/{svg|png}?style=…
```

### 21.3 Agents
```
GET   /api/companies/{co}/agents
POST  /api/companies/{co}/agent-hires
GET   /api/agents/{id}
PATCH /api/agents/{id}
PATCH /api/agents/{id}/permissions
PATCH /api/agents/{id}/instructions
POST  /api/agents/{id}/instructions/sync
POST  /api/agents/{id}/api-keys
PATCH /api/agents/{id}/budgets
POST  /api/agents/{id}/pause
POST  /api/agents/{id}/resume
POST  /api/agents/{id}/wakeup
GET   /api/agents/me/inbox-lite              # agent self-inbox
```

### 21.4 Projects & Workspaces
```
GET/POST  /api/companies/{co}/projects
GET/PATCH /api/projects/{id}
GET/POST  /api/projects/{id}/workspaces
PATCH     /api/project-workspaces/{wsId}
GET/PATCH /api/execution-workspaces/{id}
POST      /api/execution-workspaces/{id}/close
```

### 21.5 Issues
```
GET/POST   /api/companies/{co}/issues
GET/PATCH/DELETE /api/issues/{id}
POST       /api/issues/{id}/checkout
POST       /api/issues/{id}/release
GET        /api/issues/{id}/heartbeat-context
GET/POST/DELETE /api/issues/{id}/comments[/{commentId}]
GET/POST/DELETE /api/issues/{id}/approvals
POST/DELETE /api/issues/{id}/read
POST/DELETE /api/issues/{id}/inbox-archive
GET/PUT/DELETE /api/issues/{id}/documents/{key}
GET        /api/issues/{id}/documents/{key}/revisions
GET/POST   /api/issues/{id}/work-products
PATCH/DELETE /api/work-products/{wpId}
POST       /api/companies/{co}/issues/{id}/attachments
GET        /api/attachments/{attId}/content
DELETE     /api/attachments/{attId}
POST/DELETE /api/companies/{co}/labels
POST/DELETE /api/issues/{id}/labels/{labelId}
GET        /api/issues/{id}/activity
GET        /api/issues/{id}/runs
```

### 21.6 Goals
```
GET/POST           /api/companies/{co}/goals
GET/PATCH/DELETE   /api/goals/{id}
```

### 21.7 Routines
```
GET/POST          /api/companies/{co}/routines
GET/PATCH         /api/routines/{id}
GET               /api/routines/{id}/runs
POST              /api/routines/{id}/run
POST              /api/routines/{id}/triggers
PATCH/DELETE      /api/routine-triggers/{id}
POST              /api/routine-triggers/{id}/rotate-secret
POST              /api/routine-triggers/public/{publicId}/fire
```

### 21.8 Heartbeat / Wake
```
GET /api/heartbeat-runs/{id}
GET /api/heartbeat-runs/{id}/issues
```

### 21.9 Approvals
```
GET/POST          /api/companies/{co}/approvals
GET/PATCH         /api/approvals/{id}
GET/POST          /api/approvals/{id}/comments
GET               /api/approvals/{id}/issues
```

### 21.10 Costs / Budgets / Finance
```
POST /api/companies/{co}/cost-events
POST /api/companies/{co}/finance-events                # board only

GET /api/companies/{co}/costs/summary
GET /api/companies/{co}/costs/by-agent
GET /api/companies/{co}/costs/by-agent-model
GET /api/companies/{co}/costs/by-provider
GET /api/companies/{co}/costs/by-biller
GET /api/companies/{co}/costs/by-project
GET /api/companies/{co}/costs/finance-summary
GET /api/companies/{co}/costs/finance-by-kind
GET /api/companies/{co}/costs/finance-events
GET /api/companies/{co}/costs/window-spend
GET /api/companies/{co}/costs/quota-windows

GET   /api/companies/{co}/budgets/overview
POST  /api/companies/{co}/budgets/policies
PATCH /api/companies/{co}/budgets
POST  /api/companies/{co}/budget-incidents/{id}/resolve
```

### 21.11 Activity
```
GET /api/companies/{co}/activity
POST /api/companies/{co}/activity              # board manual entry
```

### 21.12 Settings & Secrets
```
GET/PATCH  /api/instance/settings/general
GET/PATCH  /api/instance/settings/experimental
GET/PATCH  /api/instance/settings/heartbeats
GET        /api/companies/{co}/secret-providers
GET/POST   /api/companies/{co}/secrets
PATCH/DELETE /api/secrets/{id}
POST       /api/secrets/{id}/rotate
```

### 21.13 Skills
```
GET/POST          /api/companies/{co}/skills
GET               /api/companies/{co}/skills/{id}
GET               /api/companies/{co}/skills/{id}/files?path=
PATCH             /api/companies/{co}/skills/{id}/files
POST              /api/companies/{co}/skills/import
POST              /api/companies/{co}/skills/scan-projects
DELETE            /api/companies/{co}/skills/{id}
POST              /api/companies/{co}/skills/{id}/install-update
GET               /api/skills/index            # public, for agent onboarding
GET               /api/skills/paperclip
```

### 21.14 Plugins
```
GET/POST/DELETE /api/plugins[/{id}]
PATCH           /api/plugins/{id}/{enable|disable}
GET/PUT         /api/plugins/{id}/settings
… plus any plugin-mounted routes
```

### 21.15 Dashboard, Org Chart, LLM Proxy, Access
```
GET  /api/companies/{co}/dashboard               # aggregate metrics for /dashboard page
GET  /api/companies/{co}/access                  # member roles & grants
POST /api/companies/{co}/access                  # grant
DELETE /api/companies/{co}/access/{grantId}
POST /api/llms/*                                  # opt-in LLM helper proxy used by some adapters
```

### 21.16 Auth, Invites, Realtime
```
GET  /api/invites/{token}
GET  /api/invites/{token}/onboarding
GET  /api/invites/{token}/onboarding.txt
POST /api/board-claim/{token}
POST /api/cli-auth/{id}
… better-auth standard endpoints (sign-in/up/out)
GET  /api/sidebar-badges/*
GET  /api/live-updates                          # WebSocket / SSE
```

---

## 22. Appendix B — Database Schema Summary

### 22.1 Org / Auth / Settings
- `companies`, `company_logos`, `company_memberships`
- `instance_user_roles`, `principal_permission_grants`, `instance_settings`
- `auth`, `board_api_keys`, `cli_auth_challenges`, `invites`, `join_requests`

### 22.2 Agents & Runtime
- `agents`, `agent_api_keys`, `agent_runtime_state`, `agent_task_sessions`, `agent_config_revisions`, `agent_wakeup_requests`
- `heartbeat_runs`, `heartbeat_run_events`

### 22.3 Work Objects
- `issues`, `issue_comments`, `issue_attachments`, `issue_labels`, `labels`
- `issue_documents`, `documents`, `document_revisions`
- `issue_work_products`
- `issue_read_states`, `issue_inbox_archives`
- `issue_approvals`

### 22.4 Projects, Goals, Routines
- `projects`, `project_workspaces`, `project_goals`
- `execution_workspaces`, `workspace_runtime_services`, `workspace_operations`
- `goals`
- `routines`, `routine_triggers`, `routine_runs`

### 22.5 Approvals / Money / Audit
- `approvals`, `approval_comments`
- `cost_events`, `finance_events`, `budget_policies`, `budget_incidents`
- `activity_log`

### 22.6 Skills / Secrets / Assets
- `company_skills`
- `company_secrets`, `company_secret_versions`
- `assets`

### 22.7 Plugins
- `plugins`, `plugin_config`, `plugin_state`
- `plugin_jobs`, `plugin_logs`, `plugin_entities`
- `plugin_webhooks`, `plugin_company_settings`

---

## Out of Scope / Roadmap

Features explicitly **not** included in this PRD:

- **Clipmart marketplace** — one-click company import (planned).
- **CEO Chat** — conversational interface to the CEO agent (planned).
- **Maximizer Mode** — autonomous goal-pursuit at maximum throttle (planned).
- **Multiple Human Users** — full multi-tenant human user model (planned beyond the current memberships table).
- **Cloud / Sandbox Agents** — Cursor / e2b cloud-runner agent adapters (planned).
- **Cloud Deployments** — first-party hosted offering (planned).
- **Desktop App** — native client (planned).
- **Cross-instance federation** — orchestrating agents across multiple Paperclip deployments.
- **Bring-your-own ticket system** — Linear/Jira/Asana integration (roadmap).

---

*Generated from source on 2026-04-25 against master @ v0.3.1.*
