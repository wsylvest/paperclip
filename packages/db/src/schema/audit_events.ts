import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    category: text("category").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    severity: text("severity").notNull().default("info"),
    previousState: jsonb("previous_state").$type<Record<string, unknown> | null>(),
    newState: jsonb("new_state").$type<Record<string, unknown> | null>(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("audit_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyCategoryOccurredIdx: index("audit_events_company_category_occurred_idx").on(table.companyId, table.category, table.occurredAt),
    actorOccurredIdx: index("audit_events_actor_occurred_idx").on(table.actorType, table.actorId, table.occurredAt),
    entityIdx: index("audit_events_entity_idx").on(table.entityType, table.entityId),
  }),
);
