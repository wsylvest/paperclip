import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * MCP (Model Context Protocol) upstream server registrations. Each row
 * describes one external MCP server that Paperclip will proxy traffic
 * to on behalf of agents/routines/projects in a single company.
 *
 * The Paperclip MCP gateway sits in front of these servers and:
 *   - presents a single merged tool catalog to each agent CLI
 *   - enforces per-principal grants from `mcp_server_grants`
 *   - records every invocation in `mcp_invocations` for audit + cost
 *   - substitutes `${secret:<uuid>}` placeholders from `company_secrets`
 *
 * @see PLUGIN_SPEC.md and doc/SPEC-implementation.md for the broader
 * control-plane invariants these tables compose with.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** stdio | streamable_http | sse_legacy */
    transport: text("transport").notNull().default("streamable_http"),
    /** URL for http transports, or command string for stdio */
    endpoint: text("endpoint").notNull(),
    /** none | bearer_ref | oauth_ref | signed_jwt */
    authType: text("auth_type").notNull().default("none"),
    /** Pointer into company_secrets when authType != 'none' */
    authSecretRef: uuid("auth_secret_ref"),
    /** Discovered tools/resources/prompts from the upstream server */
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>(),
    /** Subset of capabilities exposed to grantees. null = all discovered. */
    allowlist: jsonb("allowlist").$type<Record<string, unknown> | null>(),
    /** healthy | degraded | dead | unknown */
    healthStatus: text("health_status").notNull().default("unknown"),
    healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
    consecutiveFails: integer("consecutive_fails").notNull().default(0),
    /** Fixed per-call surcharge in microcents (1e-6 USD) charged for gateway overhead. */
    surchargeMicrocents: integer("surcharge_microcents").notNull().default(0),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("mcp_servers_company_idx").on(table.companyId),
    companyHealthIdx: index("mcp_servers_company_health_idx").on(
      table.companyId,
      table.healthStatus,
    ),
    companyNameUq: uniqueIndex("mcp_servers_company_name_uq").on(
      table.companyId,
      table.name,
    ),
  }),
);

/**
 * Per-principal authorisation rows: which agent / routine / project /
 * company can call which tools on which MCP server.
 *
 * Resolution order at gateway time:
 *   1. Look up grants for the caller's principal (agentId from JWT).
 *   2. Fall back to project/company-scoped grants.
 *   3. If no grant matches, deny.
 *
 * `toolAllowlist=null` means "inherit the parent mcp_servers.allowlist";
 * an empty array means "no tools allowed" (explicit deny).
 */
export const mcpServerGrants = pgTable(
  "mcp_server_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    /** agent | routine | project | company */
    principalType: text("principal_type").notNull(),
    /** uuid of the principal; null when principalType='company' */
    principalId: uuid("principal_id"),
    /** Subset of server tools this principal may call. null = inherit server allowlist. */
    toolAllowlist: jsonb("tool_allowlist").$type<string[] | null>(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("mcp_server_grants_company_idx").on(table.companyId),
    serverIdx: index("mcp_server_grants_server_idx").on(table.mcpServerId),
    principalIdx: index("mcp_server_grants_principal_idx").on(
      table.companyId,
      table.principalType,
      table.principalId,
    ),
    serverPrincipalUq: uniqueIndex("mcp_server_grants_server_principal_uq").on(
      table.mcpServerId,
      table.principalType,
      table.principalId,
    ),
  }),
);

/**
 * Audit + cost log: one row per tool call routed through the gateway.
 *
 * Payload bodies are NOT stored — only SHA-256 hashes — to keep secret
 * values and large payloads out of the database. `costMicrocents` feeds
 * the existing budget hard-stop via `cost_events`.
 *
 * `approvalId` is set when a tool was gated by an approval policy and
 * the call was paused/resumed through the standard approvals flow.
 */
export const mcpInvocations = pgTable(
  "mcp_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    requestPayloadHash: text("request_payload_hash"),
    responsePayloadHash: text("response_payload_hash"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** pending | succeeded | failed | denied | approval_pending */
    status: text("status").notNull().default("pending"),
    errorClass: text("error_class"),
    costMicrocents: integer("cost_microcents").notNull().default(0),
    approvalId: uuid("approval_id"),
  },
  (table) => ({
    companyIdx: index("mcp_invocations_company_idx").on(table.companyId),
    runIdx: index("mcp_invocations_run_idx").on(table.runId),
    serverIdx: index("mcp_invocations_server_idx").on(table.mcpServerId),
    startedIdx: index("mcp_invocations_started_idx").on(table.startedAt),
  }),
);
