# Paperclip Platform Buildout: Phased Implementation Plan

## Overview

Paperclip v0.3.1 is ~85% production-ready. This plan builds all aspirational features across 6 phases (~22 weeks, ~235 new/modified files). Payment integration uses Stripe. Accounting integration supports QuickBooks Online or Xero. Includes robust admin interface with reporting, analytics, and audit logging.

## Phase Summary

| Phase | Focus | Priority | Weeks | New Files |
|-------|-------|----------|-------|-----------|
| **1** | Admin Governance & Multi-User Roles | Critical | 1–3 | ~30 |
| **2** | Reporting, Analytics & CEO Chat | High | 4–6 | ~35 |
| **3** | Stripe Payments & Accounting Integration | High | 7–10 | ~45 |
| **4** | Agent Capabilities (Artifacts, Cloud Sandbox, MAXIMIZER) | Medium | 11–14 | ~50 |
| **5** | Clipmart Marketplace & External Secrets | Medium | 15–18 | ~40 |
| **6** | Desktop App & Platform Hardening | Lower | 19–22 | ~35 |

## Cross-Cutting Rules

1. Every service = `entityService(db: Db)` factory, errors via `notFound()` / `forbidden()` / `unprocessable()`
2. Every mutation = `logActivity(db, {...})` + `auditService.logAuditEvent(...)`
3. Every route = `validate(zodSchema)` middleware + `assertBoard/assertCompanyAccess/assertInstanceAdmin`
4. Every new table = uuid PK `.defaultRandom()`, `companyId` FK where applicable, timestamps with timezone
5. Every WebSocket-worthy mutation = `publishLiveEvent({ companyId, type, payload })`

## Existing Infrastructure to Build On

| Asset | Location | Purpose |
|-------|----------|---------|
| `financeEvents` table | `packages/db/src/schema/finance_events.ts` | Debit/credit ledger with `externalInvoiceId`, `metadataJson`, `direction`, `currency` |
| `financeService` | `server/src/services/finance.ts` | `createEvent`, `summary`, `byBiller`, `byKind`, `list` |
| `costEvents` + `budgetPolicies` + `budgetIncidents` | `packages/db/src/schema/` | Token cost tracking, scoped budgets, threshold violations |
| `companyMemberships` | `packages/db/src/schema/company_memberships.ts` | `principalType`, `principalId`, `membershipRole` |
| `principalPermissionGrants` | `packages/db/src/schema/` | Granular permission keys with `scope` JSONB |
| `activityLog` | `packages/db/src/schema/activity_log.ts` | Immutable audit trail |
| `issueWorkProducts` | `packages/db/src/schema/issue_work_products.ts` | `type`, `provider`, `url`, `status`, `metadata` |
| `executionWorkspaces` | `packages/db/src/schema/execution_workspaces.ts` | Already has `strategyType: "cloud_sandbox"`, `providerRef` |
| Company portability | `server/src/services/company-portability.ts` | Full org export/import — foundation for Clipmart |
| Plugin SDK | `packages/plugins/sdk/` | JSON-RPC events/jobs/tools/data/launchers |

---

## Phase 1: Admin Governance & Multi-User Roles (Weeks 1–3)

### Database (migration `0046`)

**Alter `company_memberships`**: add `invited_by TEXT`, `last_active_at TIMESTAMPTZ`

**New table `audit_events`**: `id` uuid PK, `companyId` uuid FK nullable, `actorType` text, `actorId` text, `category` text (`auth|access|finance|config|data|agent|system`), `action` text, `entityType` text, `entityId` text, `severity` text (`info|warning|critical`), `previousState` jsonb, `newState` jsonb, `ipAddress` text, `userAgent` text, `metadata` jsonb, `occurredAt` timestamptz, `createdAt` timestamptz. Indexes: `(company_id, occurred_at)`, `(company_id, category, occurred_at)`, `(actor_type, actor_id, occurred_at)`, `(entity_type, entity_id)`

**New table `audit_retention_policies`**: `id`, `companyId`, `category`, `retentionDays`, `isActive`, timestamps

**New table `role_permission_templates`**: `id`, `name`, `description`, `permissionKeys` jsonb, `isBuiltIn`, `createdAt`

### Constants
```typescript
MEMBERSHIP_ROLES = ["owner", "admin", "member", "viewer"] as const
AUDIT_CATEGORIES = ["auth", "access", "finance", "config", "data", "agent", "system"] as const
AUDIT_SEVERITIES = ["info", "warning", "critical"] as const
```

### Services
- **`auditService(db)`**: `logAuditEvent`, `query`, `exportCsv`, `cleanup`, `complianceSummary`
- **`adminDashboardService(db)`**: `instanceOverview`, `companyHealthSummary`, `userManagementList`
- **Modify `access.ts`**: `updateMemberRole`, `transferOwnership`, `listCompanyUsers`, role hierarchy

### Routes
- **`adminRoutes(db)`**: `GET /api/admin/overview|companies|users|system-metrics` (assertInstanceAdmin)
- **`auditRoutes(db)`**: `GET /api/companies/:companyId/audit[/export|/compliance-summary|/retention-policies]`
- **Modify `access.ts`**: `PUT .../members/:id/role`, `POST .../transfer-ownership`

### UI Pages
- `AdminDashboard.tsx`, `AdminUsers.tsx`, `AdminCompanies.tsx`, `AuditLog.tsx`, `CompanyMembers.tsx`
- API clients: `admin.ts`, `audit.ts`
- Components: `AuditEventRow`, `AuditFilters`, `MemberRoleBadge`, `SystemHealthCard`

---

## Phase 2: Reporting, Analytics & CEO Chat (Weeks 4–6)

### Database (migration `0047`)

**New table `report_snapshots`**: `id`, `companyId`, `reportType`, `periodStart`, `periodEnd`, `data` jsonb, `createdAt`

**Alter `issues`**: add `kind TEXT DEFAULT 'task'`, `scope TEXT`, `target_agent_id UUID`
**Alter `issue_comments`**: add `intent TEXT`

### Constants
```typescript
ISSUE_KINDS = ["task", "strategy", "question", "decision"] as const
COMMENT_INTENTS = ["hint", "correction", "board_question", "board_decision", "response"] as const
REPORT_TYPES = ["cost_daily", "cost_weekly", "agent_performance", "user_activity"] as const
```

### Services
- **`reportService(db)`**: `costTimeSeries`, `agentPerformance`, `userActivity`, `generateSnapshot`, `exportCsv`, `exportPdf`
- **`composerService(db)`**: `createThread` (creates issue with kind/scope), `addMessage` (comment with intent), `convertToTask`, `listThreads`

### Routes
- **`reportRoutes(db)`**: `GET .../reports/cost-time-series|agent-performance|user-activity|export`
- **`composerRoutes(db)`**: `POST/GET .../composer/threads`, `POST .../threads/:id/messages`, `POST .../threads/:id/convert-to-task`

### UI Pages
- `Reports.tsx`, `AgentPerformance.tsx`, `Composer.tsx`
- Components: `CostTimeSeriesChart`, `ReportExportButton`, `ComposerInput`, `ComposerThread`

---

## Phase 3: Stripe Payments & Accounting Integration (Weeks 7–10)

### Database (migration `0048`)

**New tables**: `stripe_customers` (companyId unique, stripeCustomerId, subscriptionStatus, currentPlanId, periodStart/End), `subscription_plans` (name, stripePriceId, baseMonthlyCents, features jsonb), `stripe_invoices` (stripeInvoiceId unique, status, amounts, urls), `payment_methods` (stripePaymentMethodId unique, type, last4, brand), `stripe_webhook_events` (stripeEventId unique, eventType, processed, payload), `accounting_connections` (companyId, provider `quickbooks_online|xero`, encrypted tokens, realmId/tenantId, chartOfAccountsMapping jsonb), `accounting_sync_log` (connectionId, direction, entityType, externalId, status)

### Services
- **`stripeService(db)`**: `createCustomer`, `createCheckoutSession`, `createSubscription`, `cancelSubscription`, `reportUsage`, `syncUsageFromFinanceEvents`, `listInvoices`, `getPortalSession`
- **`stripeWebhookService(db)`**: `handleEvent` (signature verification + idempotency), handlers for `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `checkout.session.completed`
- **`accountingService(db)`**: `initiateOAuthFlow`, `handleOAuthCallback`, `refreshTokenIfNeeded`, `syncInvoicesToAccounting`, `syncExpensesToAccounting`, `getChartOfAccounts`, `updateAccountMapping`, `disconnect`
- **`accounting-providers/quickbooks.ts`** and **`accounting-providers/xero.ts`**: OAuth2 + API clients
- **Modify `costs.ts`**: after `createEvent`, call `stripeService.reportUsage()` if active subscription

### Routes
- **`billingRoutes(db)`**: checkout, subscription CRUD, invoices, payment methods, portal, `POST /api/webhooks/stripe` (no auth, signature only)
- **`accountingRoutes(db)`**: connect/disconnect, OAuth callback, COA, mappings, sync, sync-log

### UI Pages
- `Billing.tsx`, `BillingInvoices.tsx`, `AccountingIntegration.tsx`
- Components: `PlanCard`, `PaymentMethodCard`, `InvoiceTable`, `AccountingConnectionCard`, `ChartOfAccountsMapper`

### Config
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAPERCLIP_STRIPE_ENABLED`, `PAPERCLIP_ACCOUNTING_ENABLED`

### Dependencies
- `stripe`, `xero-node`, `intuit-oauth`

---

## Phase 4: Agent Capabilities — Artifacts, Cloud Sandbox & MAXIMIZER (Weeks 11–14)

### Database (migration `0049`)

**New tables**: `deployments` (workProductId FK, environment, status, url, provider, healthStatus, commitSha, metadata), `cloud_sandboxes` (executionWorkspaceId FK, provider `e2b|fly_machines`, externalSandboxId, status, templateId, region, resources, costAccumulatedCents, expiresAt)

**Alter `companies`**: add `maximizer_enabled BOOLEAN DEFAULT false`, `maximizer_config JSONB`
**Alter `agents`**: add `autonomy_level TEXT DEFAULT 'standard'`, `parallel_execution_limit INTEGER DEFAULT 1`

### Services
- **`deploymentService(db)`**: `create`, `updateStatus`, `checkHealth`, `rollback`, `listForIssue/Company`
- **`cloudSandboxService(db)`**: `provision`, `terminate`, `extend`, `pollStatus`, `listActive`
- **`e2b` adapter** (`packages/adapters/e2b-cloud/`): implements adapter pattern with `execute(context)`
- **`maximizerService(db)`**: `evaluateAutoEscalation`, `scheduleParallelExecution`, `assessAutonomyGate`
- **Modify `heartbeat.ts`**: parallel runs for maximizer, cloud sandbox provisioning

### Routes
- **`deploymentRoutes(db)`**: CRUD + rollback + health-check
- **`cloudSandboxRoutes(db)`**: provision, list, terminate, extend

### UI Pages
- `Deployments.tsx`, `DeploymentDetail.tsx`, `CloudSandboxes.tsx`, `MaximizerSettings.tsx`

---

## Phase 5: Clipmart Marketplace & External Secrets (Weeks 15–18)

### Database (migration `0050`)

**New tables**: `marketplace_listings` (slug unique, portablePackage jsonb, category, tags[], downloads, rating, status), `marketplace_reviews` (listingId FK, rating 1-5, body), `marketplace_versions` (listingId FK, version, portablePackage, changelog), `secret_provider_configs` (companyId FK, provider, config jsonb encrypted, status)

### Services
- **`marketplaceService(db)`**: `publish`, `list`, `getBySlug`, `import` (delegates to `companyPortabilityService`), `addReview`, `publishVersion`, `search`
- **Real secret providers**: `aws-secrets-manager.ts` (`@aws-sdk/client-secrets-manager`), `gcp-secret-manager.ts` (`@google-cloud/secret-manager`), `vault.ts` (HTTP API)
- **Modify `secrets/provider-registry.ts`**: dispatch to real implementations

### Routes
- **`marketplaceRoutes(db)`**: browse (public), detail, publish, import, reviews, search
- **`secretProviderRoutes(db)`**: configure, test, delete

### UI Pages
- `Marketplace.tsx`, `MarketplaceDetail.tsx`, `MarketplacePublish.tsx`, `SecretProviders.tsx`

---

## Phase 6: Desktop App & Platform Hardening (Weeks 19–22)

### Desktop App (Tauri)
- `desktop/` directory with `src-tauri/` Rust backend
- Native notifications (agent status, approvals, budget alerts)
- System tray with instance health indicator
- `paperclip://` deep links
- Auto-updater

### Multi-Instance Scaling (migration `0051`)
- **New table `instance_registry`**: instanceId, hostname, status, lastHeartbeatAt
- **`instanceRegistryService(db)`**: register, heartbeat, listActive, deregister
- **Modify `heartbeat.ts`**: PostgreSQL advisory lock for leader election
- **`docker/docker-compose.cloud.yml`**: multi-replica behind nginx

### Platform Hardening
- Request ID middleware (`x-request-id`)
- Rate limiting middleware (in-memory or Redis)
- Deep health checks (DB, Stripe, accounting, plugins)
- WebSocket reconnection with missed-event replay

---

## Critical Barrel Files — Must Update Per Phase

| File | Role |
|------|------|
| `server/src/app.ts` | Mount all new routes |
| `packages/db/src/schema/index.ts` | Export all new tables |
| `packages/shared/src/constants.ts` | All new `as const` enums |
| `packages/shared/src/validators/index.ts` | Export all new Zod schemas |
| `server/src/services/index.ts` | Export all new services |
| `server/src/routes/index.ts` | Export all new route factories |
| `ui/src/lib/queryKeys.ts` | All new React Query key namespaces |
| `ui/src/App.tsx` | Register all new UI routes |
