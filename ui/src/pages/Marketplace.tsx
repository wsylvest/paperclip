import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { marketplaceApi } from "../api/marketplace";
import type { MarketplaceListing } from "../api/marketplace";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Store, Download, Star } from "lucide-react";

const CATEGORIES = [
  { value: "__all__", label: "All Categories" },
  { value: "startup", label: "Startup" },
  { value: "agency", label: "Agency" },
  { value: "engineering", label: "Engineering" },
  { value: "marketing", label: "Marketing" },
  { value: "support", label: "Support" },
  { value: "finance", label: "Finance" },
  { value: "custom", label: "Custom" },
];

export function Marketplace() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Marketplace" }]);
  }, [setBreadcrumbs]);

  const params = {
    ...(category ? { category } : {}),
    ...(search ? { search } : {}),
  };

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.marketplace.listings(params),
    queryFn: () => marketplaceApi.list(params),
  });

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const listings: MarketplaceListing[] = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Marketplace</h1>
      </div>

      <div className="flex items-center gap-3">
        <Input
          placeholder="Search listings..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <Select
          value={category ?? "__all__"}
          onValueChange={(v) => setCategory(v === "__all__" ? undefined : v)}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All Categories" />
          </SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {listings.length === 0 ? (
        <EmptyState icon={Store} message="No listings found." />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {listings.map((listing) => (
            <button
              key={listing.id}
              type="button"
              className="rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent"
              onClick={() => navigate(`marketplace/${listing.slug}`)}
            >
              <div className="flex items-start justify-between">
                <h3 className="font-semibold">{listing.name}</h3>
                <Badge variant="secondary">{listing.category}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                {listing.description}
              </p>
              <div className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Download className="h-3 w-3" />
                  {listing.downloads}
                </span>
                {listing.averageRating && (
                  <span className="flex items-center gap-1">
                    <Star className="h-3 w-3" />
                    {listing.averageRating} ({listing.ratingCount})
                  </span>
                )}
                {listing.version && (
                  <span>v{listing.version}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
