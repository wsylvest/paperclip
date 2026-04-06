import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { executionWorkspaces } from "./execution_workspaces.js";

export const cloudSandboxes = pgTable(
  "cloud_sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    executionWorkspaceId: uuid("execution_workspace_id").references(() => executionWorkspaces.id),
    agentId: uuid("agent_id").references(() => agents.id),
    provider: text("provider").notNull(),
    externalSandboxId: text("external_sandbox_id"),
    status: text("status").notNull().default("provisioning"),
    templateId: text("template_id"),
    region: text("region"),
    cpuCores: integer("cpu_cores"),
    memoryMb: integer("memory_mb"),
    timeoutSeconds: integer("timeout_seconds"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    costAccumulatedCents: integer("cost_accumulated_cents").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("cloud_sandboxes_company_status_idx").on(table.companyId, table.status),
    companyAgentIdx: index("cloud_sandboxes_company_agent_idx").on(table.companyId, table.agentId),
  }),
);
