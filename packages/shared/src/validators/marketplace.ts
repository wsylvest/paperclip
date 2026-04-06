import { z } from "zod";
import { MARKETPLACE_CATEGORIES } from "../constants.js";

export const publishListingSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  longDescription: z.string().max(10000).optional(),
  category: z.enum(MARKETPLACE_CATEGORIES),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
});
export type PublishListing = z.infer<typeof publishListingSchema>;

export const importListingSchema = z.object({
  collisionStrategy: z.enum(["skip", "overwrite", "rename"]).default("skip"),
});
export type ImportListing = z.infer<typeof importListingSchema>;

export const addReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().max(200).optional(),
  body: z.string().min(1).max(5000),
});
export type AddReview = z.infer<typeof addReviewSchema>;

export const marketplaceQuerySchema = z.object({
  category: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type MarketplaceQuery = z.infer<typeof marketplaceQuerySchema>;
