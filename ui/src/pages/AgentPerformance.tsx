import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { reportsApi } from "../api/reports";
import type { AgentPerformanceRow } from "../api/reports";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { BarChart3 } from "lucide-react";

type SortField = "agentName" | "tasksCompleted" | "avgResolutionHours" | "totalCostCents" | "successRate";
type SortDir = "asc" | "desc";

function comparator(field: SortField, dir: SortDir) {
  return (a: AgentPerformanceRow, b: AgentPerformanceRow) => {
    let av: number | string;
    let bv: number | string;
    if (field === "agentName") {
      av = a.agentName.toLowerCase();
      bv = b.agentName.toLowerCase();
    } else if (field === "avgResolutionHours") {
      av = a.avgResolutionHours ?? Infinity;
      bv = b.avgResolutionHours ?? Infinity;
    } else {
      av = a[field];
      bv = b[field];
    }
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  };
}

export function AgentPerformance() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [sortField, setSortField] = useState<SortField>("tasksCompleted");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Reports", href: "../reports" },
      { label: "Agent Performance" },
    ]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const query = useQuery({
    queryKey: queryKeys.reports.agentPerformance(companyId),
    queryFn: () => reportsApi.agentPerformance(companyId),
    enabled: !!companyId,
  });

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  function sortIndicator(field: SortField) {
    if (sortField !== field) return "";
    return sortDir === "asc" ? " \u25B2" : " \u25BC";
  }

  if (!companyId) {
    return <EmptyState icon={BarChart3} message="Select a company to view agent performance." />;
  }

  if (query.isLoading) return <PageSkeleton variant="list" />;

  if (!query.data || query.data.length === 0) {
    return <EmptyState icon={BarChart3} message="No agent performance data available." />;
  }

  const sorted = [...query.data].sort(comparator(sortField, sortDir));

  const columns: { key: SortField; label: string; align: string }[] = [
    { key: "agentName", label: "Agent", align: "text-left" },
    { key: "tasksCompleted", label: "Tasks Completed", align: "text-right" },
    { key: "avgResolutionHours", label: "Avg Resolution (hrs)", align: "text-right" },
    { key: "totalCostCents", label: "Total Cost ($)", align: "text-right" },
    { key: "successRate", label: "Success Rate", align: "text-right" },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Agent Performance</h1>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-2 font-medium cursor-pointer select-none ${col.align}`}
                  onClick={() => toggleSort(col.key)}
                >
                  {col.label}{sortIndicator(col.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.agentId} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{row.agentName}</td>
                <td className="px-4 py-2 text-right">{row.tasksCompleted}</td>
                <td className="px-4 py-2 text-right font-mono">
                  {row.avgResolutionHours != null ? row.avgResolutionHours.toFixed(1) : "-"}
                </td>
                <td className="px-4 py-2 text-right font-mono">
                  ${(row.totalCostCents / 100).toFixed(2)}
                </td>
                <td className="px-4 py-2 text-right">
                  {(row.successRate * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
