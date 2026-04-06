import { pgTable, uuid, text, timestamp, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const stripeWebhookEvents = pgTable(
  "stripe_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeEventId: text("stripe_event_id").notNull(),
    eventType: text("event_type").notNull(),
    processed: boolean("processed").notNull().default(false),
    processingError: text("processing_error"),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stripeEventUniq: uniqueIndex("stripe_webhook_events_stripe_event_uniq").on(table.stripeEventId),
  }),
);
