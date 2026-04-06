import { pgTable, uuid, text, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";

export const rolePermissionTemplates = pgTable(
  "role_permission_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    permissionKeys: jsonb("permission_keys").notNull().$type<string[]>(),
    isBuiltIn: boolean("is_built_in").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
