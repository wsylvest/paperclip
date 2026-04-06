import { pgTable, uuid, text, timestamp, integer, jsonb, boolean } from "drizzle-orm/pg-core";

export const subscriptionPlans = pgTable("subscription_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  stripePriceId: text("stripe_price_id"),
  stripeMeteredPriceId: text("stripe_metered_price_id"),
  baseMonthlyCents: integer("base_monthly_cents").notNull().default(0),
  includedUsageCents: integer("included_usage_cents").notNull().default(0),
  overageRateCentsPer1000: integer("overage_rate_cents_per_1000").notNull().default(0),
  features: jsonb("features").$type<Record<string, unknown> | null>(),
  isActive: boolean("is_active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
