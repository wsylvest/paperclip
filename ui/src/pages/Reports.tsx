import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { reportsApi } from "../api/reports";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { BarChart3 } from "lucide-react";

type Tab = "costs" | "agent-performance" | "user-activity";

export function Reports() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [activeTab, setActiveTab] = useState<Tab>("costs");

  useEffect(() => {
    setBreadcrumbs([{ label: "Reports" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const costQuery = useQuery({
    queryKey: queryKeys.reports.costTimeSeries(companyId),
    queryFn: () => reportsApi.costTimeSeries(companyId),
    enabled: !!companyId && activeTab === "costs",
  });

  const agentQuery = useQuery({
    queryKey: queryKeys.reports.agentPerformance(companyId),
    queryFn: () => reportsApi.agentPerformance(companyId),
    enabled: !!companyId && activeTab === "agent-performance",
  });

  const userQuery = useQuery({
    queryKey: queryKeys.reports.userActivity(companyId),
    queryFn: () => reportsApi.userActivity(companyId),
    enabled: !!companyId && activeTab === "user-activity",
  });

  if (!companyId) {
    return <EmptyState icon={BarChart3} message="Select a company to view reports." />;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "costs", label: "Costs" },
    { key: "agent-performance", label: "Agent Performance" },
    { key: "user-activity", label: "User Activity" },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Reports</h1>

      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "costs" && (
        <>
          {costQuery.isLoading && <PageSkeleton variant="list" />}
          {costQuery.data && costQuery.data.length === 0 && (
            <EmptyState icon={BarChart3} message="No cost data available for this period." />
          )}
          {costQuery.data && costQuery.data.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">Period</th>
                    <th className="px-4 py-2 text-right font-medium">Cost ($)</th>
                    <th className="px-4 py-2 text-right font-medium">Event Count</th>
                  </tr>
                </thead>
                <tbody>
                  {costQuery.data.map((row, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-4 py-2">{row.period}</td>
                      <td className="px-4 py-2 text-right font-mono">
                        ${(row.costCents / 100).toFixed(2)}
                      </td>
                      <td className="px-4 py-2 text-right">{row.eventCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {activeTab === "agent-performance" && (
        <>
          {agentQuery.isLoading && <PageSkeleton variant="list" />}
          {agentQuery.data && agentQuery.data.length === 0 && (
            <EmptyState icon={BarChart3} message="No agent performance data available." />
          )}
          {agentQuery.data && agentQuery.data.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">Agent</th>
                    <th className="px-4 py-2 text-right font-medium">Tasks Completed</th>
                    <th className="px-4 py-2 text-right font-medium">Avg Resolution (hrs)</th>
                    <th className="px-4 py-2 text-right font-medium">Total Cost ($)</th>
                    <th className="px-4 py-2 text-right font-medium">Success Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {agentQuery.data.map((row) => (
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
          )}
        </>
      )}

      {activeTab === "user-activity" && (
        <>
          {userQuery.isLoading && <PageSkeleton variant="list" />}
          {userQuery.data && userQuery.data.length === 0 && (
            <EmptyState icon={BarChart3} message="No user activity data available." />
          )}
          {userQuery.data && userQuery.data.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-4 py-2 text-left font-medium">User</th>
                    <th className="px-4 py-2 text-right font-medium">Actions</th>
                    <th className="px-4 py-2 text-left font-medium">Last Active</th>
                    <th className="px-4 py-2 text-left font-medium">Top Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {userQuery.data.map((row) => (
                    <tr key={row.userId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 font-mono text-xs">{row.userId}</td>
                      <td className="px-4 py-2 text-right">{row.actionCount}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {row.lastActiveAt
                          ? new Date(row.lastActiveAt).toLocaleString()
                          : "-"}
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {row.topActions.join(", ") || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
