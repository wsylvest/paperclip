import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { auditApi } from "../api/audit";
import type { AuditQueryFilters } from "../api/audit";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileText, Download, RotateCcw } from "lucide-react";

const CATEGORIES = ["auth", "access", "finance", "config", "data", "agent", "system"];
const SEVERITIES = ["info", "warning", "critical"];

function severityVariant(severity: string): "default" | "secondary" | "destructive" | "outline" {
  switch (severity) {
    case "critical":
      return "destructive";
    case "warning":
      return "outline";
    default:
      return "secondary";
  }
}

export function AuditLog() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [category, setCategory] = useState<string | undefined>(undefined);
  const [severity, setSeverity] = useState<string | undefined>(undefined);
  const [limit] = useState(100);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: "Audit Log" }]);
  }, [setBreadcrumbs]);

  const filters: AuditQueryFilters = {
    ...(category && { category }),
    ...(severity && { severity }),
    limit,
    offset,
  };

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.audit.list(selectedCompanyId!, filters),
    queryFn: () => auditApi.list(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={FileText} message="Select a company to view audit logs." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const resetFilters = () => {
    setCategory(undefined);
    setSeverity(undefined);
    setOffset(0);
  };

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  const exportUrl = auditApi.exportCsv(selectedCompanyId, {
    category,
    severity,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Select
          value={category ?? "all"}
          onValueChange={(v) => {
            setCategory(v === "all" ? undefined : v);
            setOffset(0);
          }}
        >
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={severity ?? "all"}
          onValueChange={(v) => {
            setSeverity(v === "all" ? undefined : v);
            setOffset(0);
          }}
        >
          <SelectTrigger className="w-[140px] h-8 text-xs">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All severities</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="ghost" size="sm" onClick={resetFilters}>
          <RotateCcw className="h-3 w-3 mr-1" />
          Reset
        </Button>

        <div className="ml-auto">
          <a
            href={exportUrl}
            download
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Download className="h-3 w-3" />
            Export CSV
          </a>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {items.length === 0 && (
        <EmptyState icon={FileText} message="No audit events found." />
      )}

      {items.length > 0 && (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 px-3 font-medium">Time</th>
                <th className="py-2 px-3 font-medium">Actor</th>
                <th className="py-2 px-3 font-medium">Category</th>
                <th className="py-2 px-3 font-medium">Action</th>
                <th className="py-2 px-3 font-medium">Entity</th>
                <th className="py-2 px-3 font-medium">Severity</th>
              </tr>
            </thead>
            <tbody>
              {items.map((event) => (
                <tr key={event.id} className="border-b">
                  <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                    {new Date(event.occurredAt).toLocaleString()}
                  </td>
                  <td className="py-2 px-3">
                    {event.actorType}:{event.actorId.slice(0, 8)}
                  </td>
                  <td className="py-2 px-3 text-muted-foreground">
                    {event.category}
                  </td>
                  <td className="py-2 px-3">{event.action}</td>
                  <td className="py-2 px-3 text-muted-foreground">
                    {event.entityType}:{event.entityId.slice(0, 8)}
                  </td>
                  <td className="py-2 px-3">
                    <Badge variant={severityVariant(event.severity)}>
                      {event.severity}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {offset + 1}&ndash;{offset + items.length} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + items.length >= total}
                onClick={() => setOffset(offset + limit)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
