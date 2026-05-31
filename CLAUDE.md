# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Paperclip is a control plane for AI-agent companies — an Express/Node API + React/Vite UI that orchestrates a team of AI agents (OpenClaw, Claude Code, Codex, Cursor, etc.) into an "org chart" with goals, budgets, ticketing, approvals, and governance. It is a pnpm monorepo targeting Node 20+.

The implementation target is V1, defined in `doc/SPEC-implementation.md`. Before non-trivial changes, AGENTS.md directs contributors to read `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, and `doc/DATABASE.md`.

## Common Commands

```sh
pnpm dev              # API + UI, watch mode (idempotent — reuses running dev runner)
pnpm dev:once         # Single run without file watching; auto-applies pending local migrations
pnpm dev:list         # Show the managed dev runner for this repo
pnpm dev:stop         # Stop the managed dev runner
pnpm dev:server       # Server only
pnpm dev:ui           # UI only

pnpm build            # pnpm -r build
pnpm typecheck        # pnpm -r typecheck
pnpm test             # vitest (watch)
pnpm test:run         # vitest run (single pass)

pnpm db:generate      # Compile packages/db, then generate Drizzle migration
pnpm db:migrate       # Apply migrations
pnpm db:backup        # One-off DB backup via scripts/backup-db.sh

pnpm paperclipai <cmd>   # Run the Paperclip CLI from source
pnpm test:e2e            # Playwright E2E (tests/e2e/playwright.config.ts)
pnpm smoke:openclaw-join # End-to-end OpenClaw invite/join smoke
```

### Running a single test

Vitest is configured at the root to aggregate projects (`packages/db`, `packages/adapters/codex-local`, `packages/adapters/opencode-local`, `server`, `ui`, `cli`). To target one project or file:

```sh
pnpm --filter @paperclipai/server exec vitest run src/routes/issues.test.ts
pnpm --filter @paperclipai/server exec vitest run -t "name of test"
pnpm -r test -- --project server
```

### Verification before hand-off (from AGENTS.md §7)

```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

If any step cannot be run, explicitly report what was skipped and why.

## Dev environment specifics

- Leave `DATABASE_URL` unset in dev — the server runs embedded PGlite/Postgres and persists at `~/.paperclip/instances/default/db`. Override with `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID`.
- API and UI are both served on `http://localhost:3100` in dev (UI is mounted via Vite middleware on the API server).
- Reset local dev DB: `rm -rf ~/.paperclip/instances/default/db` (or `rm -rf data/pglite` for the legacy dev path), then `pnpm dev`.
- Health checks: `curl http://localhost:3100/api/health` and `curl http://localhost:3100/api/companies`.
- When working across multiple git worktrees, **do not** point two dev servers at the same embedded Postgres. Use `pnpm paperclipai worktree init` (or `worktree:make`) to create an isolated instance under `~/.paperclip-worktrees/`.
- `pnpm-lock.yaml` is owned by CI on `master`. Do not commit lockfile changes in PRs; CI regenerates and commits it.

## Architecture

### Workspace layout (pnpm-workspace.yaml)

- `server/` — Express REST API, orchestration services, realtime, auth, middleware. Entry: `server/src/index.ts` → `app.ts`.
- `ui/` — React + Vite board UI (shadcn-style components). Served by the API in dev.
- `packages/db/` — Drizzle schema (`src/schema/*.ts`), migrations, client, embedded-postgres bootstrap, backup/restore. `drizzle.config.ts` reads **compiled** schema from `dist/`, which is why `pnpm db:generate` builds `packages/db` first.
- `packages/shared/` — types, constants, Zod validators, API path constants shared across server/ui/cli.
- `packages/adapters/` — one package per agent runtime: `claude-local`, `codex-local`, `cursor-local`, `gemini-local`, `opencode-local`, `pi-local`, `openclaw-gateway`.
- `packages/adapter-utils/` — shared adapter helpers.
- `packages/plugins/sdk/` + `packages/plugins/create-paperclip-plugin/` + `packages/plugins/examples/` — the plugin system.
- `cli/` — `paperclipai` CLI (setup + client control-plane commands).
- `doc/` — operational and product docs; `doc/plans/` for dated plan documents (`YYYY-MM-DD-slug.md`).
- `skills/`, `evals/`, `scripts/`, `tests/e2e`, `tests/release-smoke`.

### Server shape (`server/src`)

- `app.ts` composes the Express app: `httpLogger`, `actorMiddleware` (actor resolution), `boardMutationGuard`, `privateHostnameGuard`, then mounts `routes/*`.
- `routes/` defines the REST surface under `/api`: `companies`, `agents`, `projects`, `issues`, `goals`, `approvals`, `costs`, `activity`, `dashboard`, `routines`, `execution-workspaces`, `secrets`, `plugins`, `assets`, `llms`, `access`, `instance-settings`, `sidebar-badges`, `health`, plus `issues-checkout-wakeup` and `org-chart-svg`.
- `services/` holds domain logic: heartbeat runner, issue assignment/wakeup, approvals, budgets, costs/finance, activity logging, workspace runtime + operations, plugin lifecycle/loader/worker-manager/job-coordinator/tool-dispatcher/event-bus, secrets, etc.
- `auth/` + `middleware/auth.ts` resolve actor identity. Two actor classes:
  - **Board** (human operator): full-control over a company, cookie/session based.
  - **Agent**: bearer API key → `agent_api_keys` (hashed at rest); must not cross company boundaries.
- `realtime/` pushes live events; `storage/` abstracts local-disk vs pluggable storage; `secrets/` wraps the local-encrypted secrets adapter (`~/.paperclip/instances/default/secrets/master.key`).

### Data model (`packages/db/src/schema`)

Every domain entity is **company-scoped** and routes/services must enforce that boundary. Core tables include `companies`, `agents`, `agent_api_keys`, `projects`, `issues` (+ `issue_comments`, `issue_approvals`, `issue_work_products`, `issue_attachments`, `issue_labels`, `issue_read_states`), `goals`, `project_goals`, `approvals`, `routines`, `heartbeat_runs`, `heartbeat_run_events`, `agent_wakeup_requests`, `agent_runtime_state`, `agent_task_sessions`, `agent_config_revisions`, `execution_workspaces`, `workspace_runtime_services`, `workspace_operations`, `budget_policies`, `budget_incidents`, `cost_events`, `finance_events`, `activity_log`, `company_secrets` (+ versions), `company_skills`, `plugins` (+ `plugin_config`, `plugin_state`, `plugin_jobs`, `plugin_logs`, `plugin_entities`, `plugin_webhooks`, `plugin_company_settings`), `invites`, `join_requests`, `auth`, `board_api_keys`, `instance_settings`, `instance_user_roles`, `principal_permission_grants`.

### Control-plane invariants (AGENTS.md §5)

Preserve these — they are load-bearing:

1. Single-assignee task model.
2. Atomic issue checkout semantics (no double-work).
3. Approval gates for governed actions.
4. Budget hard-stop auto-pause behavior.
5. Activity-log entries on all mutating actions.
6. Keep every entity company-scoped; enforce access in both routes and services.

### Contract synchronization rule

When schema or API behavior changes, update **all** of: `packages/db` schema + exports → `packages/shared` types/constants/validators → `server` routes/services → `ui` API clients and pages. New tables must be re-exported from `packages/db/src/schema/index.ts` so `drizzle-kit` picks them up.

### DB migration workflow

1. Edit `packages/db/src/schema/*.ts` and export from `schema/index.ts`.
2. `pnpm db:generate` (compiles `packages/db`, then runs drizzle-kit).
3. `pnpm -r typecheck` to validate.

### API conventions

- All routes under `/api`.
- Apply company access checks and actor-class checks (board vs agent) on every endpoint.
- Write an `activity_log` entry for every mutation.
- Return consistent HTTP error codes: `400/401/403/404/409/422/500`.

## Project-specific conventions

- Strategic docs (`doc/SPEC.md`, `doc/SPEC-implementation.md`) are additive — do not wholesale replace without being asked. Keep them aligned.
- New plan docs go in `doc/plans/` and follow `YYYY-MM-DD-slug.md`.
- Secret values are never persisted inline in agent config — only secret refs. Strict mode (`PAPERCLIP_SECRETS_STRICT_MODE=true`) requires refs for `*_API_KEY` / `*_TOKEN` / `*_SECRET`. Use `pnpm secrets:migrate-inline-env` for existing inline secrets.
- Company deletion is a dev/debug capability: enabled by default in `local_trusted`, disabled in `authenticated`. Toggle with `PAPERCLIP_ENABLE_COMPANY_DELETION`.
- Forbidden-token check: `pnpm check:tokens` (run by CI; enforces scripted token-banlist via `scripts/check-forbidden-tokens.mjs`).

## PR guidance (from CONTRIBUTING.md)

- Prefer small, focused PRs — one logical change, minimal file count.
- PR descriptions should open with a "thinking path" — top-down reasoning from product context to the specific change.
- All automated checks (including Greptile) must pass.
