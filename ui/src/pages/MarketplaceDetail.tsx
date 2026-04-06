import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { marketplaceApi } from "../api/marketplace";
import type { MarketplaceListingDetail, MarketplaceReview } from "../api/marketplace";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Store, Download, Star, Import } from "lucide-react";

export function MarketplaceDetail() {
  const { slug } = useParams<{ slug: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [showReviewForm, setShowReviewForm] = useState(false);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewTitle, setReviewTitle] = useState("");
  const [reviewBody, setReviewBody] = useState("");

  const { data: listing, isLoading } = useQuery({
    queryKey: queryKeys.marketplace.detail(slug ?? ""),
    queryFn: () => marketplaceApi.getBySlug(slug ?? ""),
    enabled: !!slug,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Marketplace", href: "marketplace" },
      { label: listing?.name ?? slug ?? "" },
    ]);
  }, [setBreadcrumbs, listing, slug]);

  const importMutation = useMutation({
    mutationFn: () =>
      marketplaceApi.importListing(listing!.id, {
        companyId: selectedCompanyId ?? "",
        collisionStrategy: "skip",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.marketplace.detail(slug ?? "") });
    },
  });

  const reviewMutation = useMutation({
    mutationFn: () =>
      marketplaceApi.addReview(listing!.id, {
        rating: reviewRating,
        title: reviewTitle || undefined,
        body: reviewBody,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.marketplace.detail(slug ?? "") });
      setShowReviewForm(false);
      setReviewTitle("");
      setReviewBody("");
      setReviewRating(5);
    },
  });

  if (isLoading) {
    return <PageSkeleton variant="detail" />;
  }

  if (!listing) {
    return <EmptyState icon={Store} message="Listing not found." />;
  }

  const detail = listing as MarketplaceListingDetail;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{detail.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{detail.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{detail.category}</Badge>
          {detail.version && <Badge variant="outline">v{detail.version}</Badge>}
        </div>
      </div>

      <div className="flex items-center gap-6 text-sm text-muted-foreground">
        <span className="flex items-center gap-1">
          <Download className="h-4 w-4" />
          {detail.downloads} downloads
        </span>
        {detail.averageRating && (
          <span className="flex items-center gap-1">
            <Star className="h-4 w-4" />
            {detail.averageRating} ({detail.ratingCount} reviews)
          </span>
        )}
      </div>

      {selectedCompanyId && (
        <Button
          onClick={() => importMutation.mutate()}
          disabled={importMutation.isPending}
        >
          <Import className="mr-2 h-4 w-4" />
          {importMutation.isPending ? "Importing..." : "Import to Company"}
        </Button>
      )}

      {detail.longDescription && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-lg font-semibold">About</h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {detail.longDescription}
          </p>
        </div>
      )}

      {detail.tags && detail.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {detail.tags.map((tag) => (
            <Badge key={tag} variant="outline">{tag}</Badge>
          ))}
        </div>
      )}

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Reviews</h2>
          <Button variant="outline" size="sm" onClick={() => setShowReviewForm(!showReviewForm)}>
            Write a Review
          </Button>
        </div>

        {showReviewForm && (
          <div className="rounded-lg border border-border bg-card p-4 space-y-3">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Rating:</label>
              <select
                className="rounded border px-2 py-1 text-sm"
                value={reviewRating}
                onChange={(e) => setReviewRating(Number(e.target.value))}
              >
                {[5, 4, 3, 2, 1].map((r) => (
                  <option key={r} value={r}>{r} star{r !== 1 ? "s" : ""}</option>
                ))}
              </select>
            </div>
            <Input
              placeholder="Review title (optional)"
              value={reviewTitle}
              onChange={(e) => setReviewTitle(e.target.value)}
            />
            <Textarea
              placeholder="Write your review..."
              value={reviewBody}
              onChange={(e) => setReviewBody(e.target.value)}
              rows={3}
            />
            <Button
              size="sm"
              onClick={() => reviewMutation.mutate()}
              disabled={reviewMutation.isPending || !reviewBody.trim()}
            >
              {reviewMutation.isPending ? "Submitting..." : "Submit Review"}
            </Button>
          </div>
        )}

        {detail.reviews && detail.reviews.length > 0 ? (
          <div className="space-y-3">
            {detail.reviews.map((review: MarketplaceReview) => (
              <div key={review.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1 text-sm font-medium">
                      <Star className="h-3 w-3" />
                      {review.rating}/5
                    </span>
                    {review.title && (
                      <span className="text-sm font-medium">{review.title}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(review.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{review.body}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No reviews yet.</p>
        )}
      </div>
    </div>
  );
}
