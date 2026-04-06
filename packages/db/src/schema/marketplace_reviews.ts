import { pgTable, uuid, text, timestamp, integer } from "drizzle-orm/pg-core";
import { marketplaceListings } from "./marketplace_listings.js";

export const marketplaceReviews = pgTable("marketplace_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id")
    .notNull()
    .references(() => marketplaceListings.id),
  userId: text("user_id").notNull(),
  rating: integer("rating").notNull(),
  title: text("title"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
