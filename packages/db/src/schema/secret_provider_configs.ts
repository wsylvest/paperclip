import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const secretProviderConfigs = pgTable(
  "secret_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("configured"),
    config: jsonb("config"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    testError: text("test_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: index("secret_provider_configs_company_id_idx").on(table.companyId),
  }),
);
