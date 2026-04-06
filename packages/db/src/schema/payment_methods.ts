import { pgTable, uuid, text, timestamp, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const paymentMethods = pgTable(
  "payment_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    stripePaymentMethodId: text("stripe_payment_method_id").notNull(),
    type: text("type").notNull(),
    last4: text("last4"),
    brand: text("brand"),
    expMonth: integer("exp_month"),
    expYear: integer("exp_year"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stripeMethodUniq: uniqueIndex("payment_methods_stripe_method_uniq").on(table.stripePaymentMethodId),
    companyIdx: index("payment_methods_company_idx").on(table.companyId),
  }),
);
