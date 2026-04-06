import { api } from "./client";

export interface MarketplaceListing {
  id: string;
  publisherUserId: string;
  publisherCompanyId: string;
  name: string;
  slug: string;
  description: string;
  longDescription: string | null;
  category: string;
  tags: string[] | null;
  version: string | null;
  portablePackage: unknown;
  agentCount: number;
  projectCount: number;
  downloads: number;
  averageRating: string | null;
  ratingCount: number;
  status: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceReview {
  id: string;
  listingId: string;
  userId: string;
  rating: number;
  title: string | null;
  body: string;
  createdAt: string;
}

export interface MarketplaceListingDetail extends MarketplaceListing {
  reviews: MarketplaceReview[];
}

export const marketplaceApi = {
  list: (params?: { category?: string; search?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.category) searchParams.set("category", params.category);
    if (params?.search) searchParams.set("search", params.search);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return api.get<MarketplaceListing[]>(`/marketplace/listings${qs ? `?${qs}` : ""}`);
  },
  search: (q: string) =>
    api.get<MarketplaceListing[]>(`/marketplace/search?q=${encodeURIComponent(q)}`),
  getBySlug: (slug: string) =>
    api.get<MarketplaceListingDetail>(`/marketplace/listings/${slug}`),
  publish: (input: {
    companyId: string;
    name: string;
    slug: string;
    description: string;
    longDescription?: string;
    category: string;
    tags?: string[];
    version?: string;
  }) => api.post<MarketplaceListing>("/marketplace/listings", input),
  updateStatus: (id: string, status: string) =>
    api.put<MarketplaceListing>(`/marketplace/listings/${id}/status`, { status }),
  addVersion: (id: string, input: { version: string; portablePackage: unknown; changelog?: string }) =>
    api.post(`/marketplace/listings/${id}/versions`, input),
  importListing: (id: string, input: { companyId: string; collisionStrategy?: string }) =>
    api.post<{ portablePackage: unknown }>(`/marketplace/listings/${id}/import`, input),
  addReview: (id: string, input: { rating: number; title?: string; body: string }) =>
    api.post<MarketplaceReview>(`/marketplace/listings/${id}/reviews`, input),
};
