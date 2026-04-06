import { pgTable, uuid, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const instanceRegistry = pgTable(
  "instance_registry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instanceId: text("instance_id").notNull(),
    hostname: text("hostname"),
    port: integer("port"),
    status: text("status").notNull().default("active"),
    version: text("version"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    instanceIdUniq: uniqueIndex("instance_registry_instance_id_uniq").on(table.instanceId),
  }),
);
