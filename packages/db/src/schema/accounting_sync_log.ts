import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { accountingConnections } from "./accounting_connections.js";

export const accountingSyncLog = pgTable(
  "accounting_sync_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    connectionId: uuid("connection_id").notNull().references(() => accountingConnections.id),
    direction: text("direction").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    externalId: text("external_id"),
    status: text("status").notNull().default("pending"),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyConnectionIdx: index("accounting_sync_log_company_connection_idx").on(table.companyId, table.connectionId),
    statusIdx: index("accounting_sync_log_status_idx").on(table.status),
  }),
);
