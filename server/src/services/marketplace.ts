import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { marketplaceListings, marketplaceReviews, marketplaceVersions } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function marketplaceService(db: Db) {
  return {
    publish: async (
      companyId: string,
      userId: string,
      data: {
        name: string;
        slug: string;
        description: string;
        longDescription?: string;
        category: string;
        tags?: string[];
        version?: string;
      },
    ) => {
      const [row] = await db
        .insert(marketplaceListings)
        .values({
          publisherUserId: userId,
          publisherCompanyId: companyId,
          name: data.name,
          slug: data.slug,
          description: data.description,
          longDescription: data.longDescription ?? null,
          category: data.category,
          tags: data.tags ?? null,
          version: data.version ?? null,
          status: "draft",
        })
        .returning();
      return row;
    },

    list: async (filters: {
      category?: string;
      search?: string;
      page?: number;
      limit?: number;
    }) => {
      const page = filters.page ?? 1;
      const limit = filters.limit ?? 20;
      const offset = (page - 1) * limit;

      const conditions = [eq(marketplaceListings.status, "published")];
      if (filters.category) {
        conditions.push(eq(marketplaceListings.category, filters.category));
      }
      if (filters.search) {
        conditions.push(
          or(
            ilike(marketplaceListings.name, `%${filters.search}%`),
            ilike(marketplaceListings.description, `%${filters.search}%`),
          )!,
        );
      }

      const rows = await db
        .select()
        .from(marketplaceListings)
        .where(and(...conditions))
        .orderBy(desc(marketplaceListings.publishedAt))
        .limit(limit)
        .offset(offset);

      return rows;
    },

    getBySlug: async (slug: string) => {
      const [row] = await db
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.slug, slug))
        .limit(1);
      if (!row) throw notFound("Listing not found");
      return row;
    },

    importListing: async (
      _companyId: string,
      listingId: string,
      _collisionStrategy: string,
    ) => {
      const [listing] = await db
        .select()
        .from(marketplaceListings)
        .where(eq(marketplaceListings.id, listingId))
        .limit(1);
      if (!listing) throw notFound("Listing not found");

      await db
        .update(marketplaceListings)
        .set({ downloads: sql`${marketplaceListings.downloads} + 1` })
        .where(eq(marketplaceListings.id, listingId));

      return { portablePackage: listing.portablePackage };
    },

    addReview: async (
      listingId: string,
      userId: string,
      review: { rating: number; title?: string; body: string },
    ) => {
      const [row] = await db
        .insert(marketplaceReviews)
        .values({
          listingId,
          userId,
          rating: review.rating,
          title: review.title ?? null,
          body: review.body,
        })
        .returning();

      // Recompute averageRating and ratingCount
      const [stats] = await db
        .select({
          avgRating: sql<string>`round(avg(${marketplaceReviews.rating})::numeric, 2)::text`,
          count: sql<number>`count(*)::int`,
        })
        .from(marketplaceReviews)
        .where(eq(marketplaceReviews.listingId, listingId));

      await db
        .update(marketplaceListings)
        .set({
          averageRating: stats.avgRating,
          ratingCount: stats.count,
          updatedAt: new Date(),
        })
        .where(eq(marketplaceListings.id, listingId));

      return row;
    },

    publishVersion: async (
      listingId: string,
      version: string,
      portablePackage: unknown,
      changelog?: string,
    ) => {
      const [row] = await db
        .insert(marketplaceVersions)
        .values({
          listingId,
          version,
          portablePackage,
          changelog: changelog ?? null,
          publishedAt: new Date(),
        })
        .returning();

      await db
        .update(marketplaceListings)
        .set({
          version,
          portablePackage,
          updatedAt: new Date(),
        })
        .where(eq(marketplaceListings.id, listingId));

      return row;
    },

    search: async (query: string) => {
      return db
        .select()
        .from(marketplaceListings)
        .where(
          and(
            eq(marketplaceListings.status, "published"),
            or(
              ilike(marketplaceListings.name, `%${query}%`),
              ilike(marketplaceListings.description, `%${query}%`),
            ),
          ),
        )
        .orderBy(desc(marketplaceListings.downloads))
        .limit(50);
    },

    updateStatus: async (listingId: string, status: string) => {
      const [row] = await db
        .update(marketplaceListings)
        .set({
          status,
          publishedAt: status === "published" ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(eq(marketplaceListings.id, listingId))
        .returning();
      if (!row) throw notFound("Listing not found");
      return row;
    },

    getReviews: async (listingId: string) => {
      return db
        .select()
        .from(marketplaceReviews)
        .where(eq(marketplaceReviews.listingId, listingId))
        .orderBy(desc(marketplaceReviews.createdAt));
    },
  };
}
