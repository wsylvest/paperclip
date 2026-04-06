import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    workProductId: uuid("work_product_id"),
    issueId: uuid("issue_id").references(() => issues.id),
    agentId: uuid("agent_id").references(() => agents.id),
    environment: text("environment").notNull(),
    status: text("status").notNull().default("pending"),
    url: text("url"),
    provider: text("provider"),
    externalDeployId: text("external_deploy_id"),
    commitSha: text("commit_sha"),
    healthCheckUrl: text("health_check_url"),
    healthStatus: text("health_status").notNull().default("unknown"),
    lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("deployments_company_status_idx").on(table.companyId, table.status),
    companyIssueIdx: index("deployments_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
