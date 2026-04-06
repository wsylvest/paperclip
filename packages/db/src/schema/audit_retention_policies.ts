import { pgTable, uuid, text, timestamp, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const auditRetentionPolicies = pgTable(
  "audit_retention_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id),
    category: text("category").notNull(),
    retentionDays: integer("retention_days").notNull().default(365),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCategoryUniq: uniqueIndex("audit_retention_policies_company_category_uniq").on(table.companyId, table.category),
  }),
);
