# Codebase Audit: Built & Working vs. Aspirational/Future

**Date:** 2026-04-02  
**Version audited:** 0.3.1  

---

## Overview

Paperclip is an open-source orchestration platform for autonomous AI companies. It coordinates teams of AI agents with org charts, task management, budgets, governance, and audit trails. This audit categorizes every major feature as **built and working** or **aspirational/future**.

---

## 1. Built & Working

### 1.1 Core Platform

| Area | Key Files | Notes |
|------|-----------|-------|
| **Express.js REST API** | `server/src/routes/` (25+ modules), `server/src/services/` (45+ modules, ~1.3MB) | Production-grade with real business logic |
| **React + Vite Frontend** | `ui/src/pages/` (40+ pages), `ui/src/components/` | Full SPA — TailwindCSS, Radix UI, React Router v7, React Query |
| **PostgreSQL Database** | `packages/db/src/schema/` (59 files), `packages/db/src/migrations/` (45+ migrations) | Drizzle ORM, embedded PG for zero-config dev |
| **CLI Tool** | `cli/` — published as `paperclipai` | Commands: onboard, configure, run, doctor |
| **Monorepo** | `pnpm-workspace.yaml`, `packages/` | pnpm workspaces with shared types, DB, adapters, plugins |

### 1.2 Agent Orchestration

| Feature | Key Files | Notes |
|---------|-----------|-------|
| **Heartbeat Engine** | `server/src/services/heartbeat.ts` (140KB) | Core execution loop — adapter invocation, session management, cost tracking, log streaming, workspace setup/teardown |
| **7 Agent Adapters** | `packages/adapters/` — claude-local, codex-local, cursor, gemini-local, opencode-local, pi-local, openclaw-gateway | Real implementations with task execution, session persistence, token usage tracking |
| **Agent Management** | `server/src/routes/agents.ts` (1400+ lines), `ui/src/pages/AgentDetail.tsx` (162KB) | Full lifecycle: create, configure, pause, terminate. Config versioning, API key generation |
| **Execution Workspaces** | `server/src/services/workspace-runtime.ts` (68KB) | Shared/isolated modes, git worktree strategy, runtime service orchestration |
| **Agent Skills** | `server/src/services/company-skills.ts` (82KB), `skills/` | Skill registry, custom skills CRUD, bundled skills (paperclip, para-memory-files) |

### 1.3 Task & Project Management

| Feature | Key Files | Notes |
|---------|-----------|-------|
| **Issue Tracking** | `server/src/routes/issues.ts`, `server/src/services/issues.ts`, `ui/src/pages/IssueDetail.tsx` | Full lifecycle: backlog → todo → in_progress → in_review → done. Single-assignee with atomic checkout, sub-issues, labels, comments, attachments |
| **Projects** | `server/src/routes/projects.ts`, `ui/src/pages/ProjectDetail.tsx` | CRUD, workspace management, goal linking |
| **Goals** | `server/src/routes/goals.ts`, `ui/src/pages/GoalDetail.tsx` | Goal tracking, context, hierarchy, default goals |
| **Scheduled Routines** | `server/src/services/routines.ts`, `ui/src/pages/RoutineDetail.tsx` | Cron-based scheduling, trigger management, run queueing |
| **Inbox** | `ui/src/pages/Inbox.tsx` (58KB) | Threaded inbox with filtering (mine/recent/unread/all) |

### 1.4 Governance & Finance

| Feature | Key Files | Notes |
|---------|-----------|-------|
| **Approval Workflows** | `server/src/services/approvals.ts`, `ui/src/pages/ApprovalDetail.tsx` | Multi-state: pending → revision_requested ↔ pending → approved/rejected. Linked to agent hires and task check-ins |
| **Budget Enforcement** | `server/src/services/budgets.ts` | Per-agent monthly budgets, hard stops, warning thresholds, budget incidents |
| **Cost Tracking** | `server/src/services/costs.ts`, `ui/src/pages/Costs.tsx` (49KB) | Token cost tracking (input/output/cached), per-agent/company/project aggregation |
| **Activity Logging** | `server/src/services/activity.ts`, `ui/src/pages/Activity.tsx` | Immutable audit trail for all mutations |

### 1.5 Access & Security

| Feature | Key Files | Notes |
|---------|-----------|-------|
| **Authentication** | `server/src/auth/better-auth.ts`, `server/src/middleware/auth.ts` | Better Auth (email/password), JWT agent auth, Board API keys, local trusted mode |
| **Authorization / RBAC** | `server/src/services/access.ts`, `server/src/routes/access.ts` (94KB) | Role-based access, permission grants, instance admin roles, company membership |
| **Local Encrypted Secrets** | `server/src/secrets/` | Secret creation, versioning with encrypted local provider |
| **Multi-Company Isolation** | Schema-level | All entities company-scoped, complete data isolation |

### 1.6 Plugin System

| Feature | Key Files | Notes |
|---------|-----------|-------|
| **Plugin Lifecycle** | `server/src/services/plugin-lifecycle.ts`, `server/src/services/plugin-loader.ts` (70KB) | Full state machine: uninstalled → pending → ready → failed |
| **Plugin SDK** | `packages/plugins/sdk/` | Manifest spec, capability validators, tool registry |
| **Plugin UI** | `ui/src/pages/PluginManager.tsx`, `ui/src/pages/PluginSettings.tsx`, `ui/src/plugins/` | Admin UI, slot system for plugin-injected UI |
| **Plugin Jobs** | `server/src/services/plugin-worker-manager.ts` | Job scheduling, webhook delivery, state persistence |

### 1.7 Portability & Ops

| Feature | Key Files | Notes |
|---------|-----------|-------|
| **Company Import/Export** | `server/src/services/company-portability.ts` (164KB), `ui/src/pages/CompanyExport.tsx`, `ui/src/pages/CompanyImport.tsx` | Export/import complete company state with preview validation |
| **Org Chart** | `server/src/routes/org-chart-svg.ts`, `ui/src/pages/OrgChart.tsx` | SVG-rendered org charts with overflow handling |
| **Real-time Updates** | `server/src/realtime/` | WebSocket-based live updates |
| **Docker Deployment** | `Dockerfile`, `docker-compose.yml`, `docker-compose.quickstart.yml` | Multi-stage production build |
| **Onboarding** | CLI `onboard` command, `ui/src/components/OnboardingWizard.tsx` | One-command setup: `npx paperclipai onboard --yes` |

### 1.8 Testing & CI

| Area | Details |
|------|---------|
| **Unit Tests** | Vitest — `server/src/__tests__/` |
| **E2E Tests** | Playwright — `tests/e2e/` |
| **Release Smoke Tests** | `tests/release-smoke/` |
| **LLM Evals** | Promptfoo — `evals/` |
| **CI/CD** | GitHub Actions — `.github/workflows/` |
| **Release Automation** | `scripts/release.sh`, canary/stable/rollback flows |

---

## 2. Aspirational / Future / Stubbed

### 2.1 Roadmap Items (Explicitly Marked ⚪ in README)

| Feature | Description | Evidence |
|---------|-------------|----------|
| **Artifacts & Deployments** | Agent-produced artifacts and deployment management | `README.md:246` |
| **CEO Chat** | Conversational interface to direct agents | `README.md:247` |
| **MAXIMIZER MODE** | Aggressive autonomous execution mode | `README.md:248` |
| **Multiple Human Users** | Multi-member boards per company | `README.md:249` — current: single-human board (V1) |
| **Cloud / Sandbox Agents** | Cloud-hosted agents (e.g. Cursor, e2b) | `README.md:250` |
| **Cloud Deployments** | Managed cloud hosting | `README.md:251` |
| **Desktop App** | Native desktop application | `README.md:252` |
| **Clipmart** | Marketplace for pre-built company templates | `README.md:46` — "COMING SOON" |

### 2.2 Stubbed Code

| Feature | Location | Details |
|---------|----------|---------|
| **AWS Secrets Manager** | `server/src/secrets/external-stub-providers.ts:24` | Returns `"not configured in this deployment"` |
| **GCP Secret Manager** | `server/src/secrets/external-stub-providers.ts:28` | Returns `"not configured in this deployment"` |
| **HashiCorp Vault** | `server/src/secrets/external-stub-providers.ts:32` | Returns `"not configured in this deployment"` |
| **Remote Plugin Registry** | `server/src/services/plugin-loader.ts:1033` | `"remote registry discovery is not yet implemented"` |
| **Some Invite Adapters** | `ui/src/pages/InviteLanding.tsx:28` | `openclaw_gateway` and `http` adapters disabled with "Coming soon" in invite flow |

### 2.3 Spec-Described but Not Implemented

| Feature | Source | Details |
|---------|--------|---------|
| **Initiatives Entity** | `doc/TASKS.md:13` | Spec describes "roadmap-level objectives, span quarters" — not in schema |
| **Milestones Entity** | `doc/TASKS.md:15` | Spec describes "stages within a project" — not in schema |
| **Custom Workflow States per Team** | `doc/TASKS.md:75-78` | Spec: teams define own states within categories. Current: fixed status enum |
| **Hiring Budgets / Auto-Approve** | `doc/SPEC.md:51` | "Future governance models (not V1)" |
| **Multi-member Boards** | `doc/SPEC.md:52` | "Future governance models (not V1)" |
| **Delegated Authority** | `doc/SPEC.md:53` | "CEO can hire within limits" — not V1 |
| **Company Lifecycle** | `doc/SPEC.md:59` | Archive/delete companies — listed as open question |
| **External Revenue/Expense Tracking** | `doc/SPEC.md:57` | Listed as "future plugin" |
| **Cloud-Ready Plugin Distribution** | `doc/plugins/PLUGIN_SPEC.md:29` | "not yet cloud-ready for horizontally scaled or ephemeral deployments" |
| **Plugin UI Component Kit** | `doc/plugins/PLUGIN_SPEC.md:30` | "does not yet ship a real host-provided plugin UI component kit" |
| **Payment/Billing Integration** | — | Cost tracking exists but no payment processor (Stripe, etc.) |
| **Username Masking in Transcripts** | `ui/src/pages/InstanceGeneralSettings.tsx:78` | "not yet masked in the live transcript view" |

---

## 3. Summary

### Maturity: ~85% of core platform built and functional

```
Built & Working                    Aspirational / Future
──────────────────────────────     ──────────────────────────────
✅ 7 agent adapters                ⚪ CEO Chat
✅ Heartbeat execution engine      ⚪ MAXIMIZER MODE
✅ Issue/task management           ⚪ Artifacts & Deployments
✅ Budget & cost tracking          ⚪ Multiple Human Users
✅ Approval workflows              ⚪ Cloud / Sandbox Agents
✅ Plugin system (local)           ⚪ Cloud Deployments
✅ Company import/export           ⚪ Desktop App
✅ Auth + RBAC                     ⚪ Clipmart marketplace
✅ Org charts                      ⚪ External secret providers
✅ Scheduled routines              ⚪ Remote plugin registry
✅ 40+ page React UI               ⚪ Initiatives & Milestones
✅ CLI + Docker deployment         ⚪ Custom workflow states
✅ Multi-company isolation         ⚪ Payment integration
✅ Real-time WebSockets            ⚪ Cloud plugin distribution
✅ Testing infra (unit/E2E/evals)  ⚪ Multi-member boards
```

**Bottom line:** The core orchestration platform — agent management, task tracking, heartbeat execution, budgets, approvals, plugins, and the full UI — is production-grade. The gaps are primarily around cloud-native deployment, marketplace features, and advanced governance models described in spec documents as future work.
