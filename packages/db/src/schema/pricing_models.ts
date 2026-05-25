import { pgTable, uuid, text, integer, timestamp, index, boolean } from "drizzle-orm/pg-core";

export const pricingModels = pgTable(
  "pricing_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Provider key — matches cost_events.provider values, e.g. 'anthropic', 'openai', 'google', 'cursor'. */
    provider: text("provider").notNull(),
    /** Model id within the provider, e.g. 'claude-sonnet-4-5', 'gpt-5'. */
    model: text("model").notNull(),
    /** Adapter type that uses this model, e.g. 'claude_local'. Optional — null = any adapter. */
    adapterType: text("adapter_type"),
    /** Input token cost in microcents per 1k tokens. 1 microcent = 1e-6 USD. */
    inputCostMicrocentsPer1k: integer("input_cost_microcents_per_1k").notNull(),
    /** Cached-input token cost in microcents per 1k tokens. Null = same as input. */
    cachedInputCostMicrocentsPer1k: integer("cached_input_cost_microcents_per_1k"),
    /** Output token cost in microcents per 1k tokens. */
    outputCostMicrocentsPer1k: integer("output_cost_microcents_per_1k").notNull(),
    /** ISO currency code. Default 'USD'. */
    currency: text("currency").notNull().default("USD"),
    /** Effective from. Allows historic pricing snapshots. */
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    /** Null = currently active. */
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    /** Active flag — soft delete + manual disable. */
    active: boolean("active").notNull().default(true),
    /** Free-form notes (provider URL, version, etc.). */
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerModelIdx: index("pricing_models_provider_model_idx").on(table.provider, table.model),
    adapterTypeIdx: index("pricing_models_adapter_type_idx").on(table.adapterType),
    activeIdx: index("pricing_models_active_idx").on(table.active),
    // One active row per (provider, model, adapterType, currency).
    // Uniqueness enforced in the service layer's upsert helper; drizzle partial-index
    // support for WHERE active = true is not universally portable here.
  }),
);
