import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { marketplaceListings } from "./marketplace_listings.js";

export const marketplaceVersions = pgTable("marketplace_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id")
    .notNull()
    .references(() => marketplaceListings.id),
  version: text("version").notNull(),
  portablePackage: jsonb("portable_package"),
  changelog: text("changelog"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
