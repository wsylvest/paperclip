import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const heartbeatRunStages = pgTable(
  "heartbeat_run_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    /** Ordinal — 1-indexed, contiguous per run. */
    ordinal: integer("ordinal").notNull(),
    /** Stage name. Conventional values: 'plan' | 'skill_analysis' | 'metadata' |
     *  'media' | 'draft' | 'publish' | 'execute' (fallback for legacy single-stage runs). */
    name: text("name").notNull(),
    /** queued | running | succeeded | failed | skipped | cancelled */
    status: text("status").notNull().default("queued"),
    /** Optional structured input passed to the adapter for this stage. */
    inputJson: jsonb("input_json"),
    /** Optional structured output emitted by the adapter at stage completion. */
    outputJson: jsonb("output_json"),
    /** When a stage fails or is skipped, the typed error class. For skipped stages,
     *  prefixed with 'skipped:' (e.g. 'skipped:gate_disabled'). */
    errorClass: text("error_class"),
    plannedAt: timestamp("planned_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runIdx: index("heartbeat_run_stages_run_idx").on(table.runId),
    runOrdinalUq: uniqueIndex("heartbeat_run_stages_run_ordinal_uq").on(table.runId, table.ordinal),
    runStatusIdx: index("heartbeat_run_stages_run_status_idx").on(table.runId, table.status),
  }),
);
