import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const marketplaceListings = pgTable(
  "marketplace_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publisherUserId: text("publisher_user_id").notNull(),
    publisherCompanyId: uuid("publisher_company_id")
      .notNull()
      .references(() => companies.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull(),
    longDescription: text("long_description"),
    category: text("category").notNull(),
    tags: text("tags").array(),
    version: text("version"),
    portablePackage: jsonb("portable_package"),
    agentCount: integer("agent_count").notNull().default(0),
    projectCount: integer("project_count").notNull().default(0),
    downloads: integer("downloads").notNull().default(0),
    averageRating: text("average_rating"),
    ratingCount: integer("rating_count").notNull().default(0),
    status: text("status").notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUniqueIdx: uniqueIndex("marketplace_listings_slug_idx").on(table.slug),
    statusPublishedAtIdx: index("marketplace_listings_status_published_at_idx").on(
      table.status,
      table.publishedAt,
    ),
  }),
);
