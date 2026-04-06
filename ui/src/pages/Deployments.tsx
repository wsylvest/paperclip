import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { deploymentsApi } from "../api/deployments";
import type { Deployment } from "../api/deployments";
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
import { Rocket, RotateCcw, Activity } from "lucide-react";

const STATUS_OPTIONS = ["pending", "building", "deploying", "live", "failed", "rolled_back"];

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "live":
      return "default";
    case "pending":
    case "building":
    case "deploying":
      return "secondary";
    case "failed":
      return "destructive";
    case "rolled_back":
      return "outline";
    default:
      return "outline";
  }
}

function healthVariant(health: string): "default" | "secondary" | "destructive" | "outline" {
  switch (health) {
    case "healthy":
      return "default";
    case "degraded":
      return "secondary";
    case "unhealthy":
      return "destructive";
    default:
      return "outline";
  }
}

export function Deployments() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);

  useEffect(() => {
    setBreadcrumbs([{ label: "Deployments" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.deployments.list(companyId, statusFilter),
    queryFn: () => deploymentsApi.list(companyId, statusFilter),
    enabled: !!companyId,
  });

  const rollbackMutation = useMutation({
    mutationFn: (id: string) => deploymentsApi.rollback(companyId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.deployments.list(companyId, statusFilter) });
    },
  });

  const healthCheckMutation = useMutation({
    mutationFn: (id: string) => deploymentsApi.healthCheck(companyId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.deployments.list(companyId, statusFilter) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Rocket} message="Select a company to view deployments." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const deployments: Deployment[] = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Deployments</h1>
        <Select
          value={statusFilter ?? "__all__"}
          onValueChange={(v) => setStatusFilter(v === "__all__" ? undefined : v)}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All statuses</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {deployments.length === 0 ? (
        <EmptyState icon={Rocket} message="No deployments found." />
      ) : (
        <div className="rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">Environment</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">URL</th>
                <th className="px-4 py-2 text-left font-medium">Provider</th>
                <th className="px-4 py-2 text-left font-medium">Health</th>
                <th className="px-4 py-2 text-left font-medium">Deployed At</th>
                <th className="px-4 py-2 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-mono text-xs">{d.environment}</td>
                  <td className="px-4 py-2">
                    <Badge variant={statusVariant(d.status)}>{d.status.replace("_", " ")}</Badge>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                        {d.url}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">{d.provider ?? "--"}</td>
                  <td className="px-4 py-2">
                    <Badge variant={healthVariant(d.healthStatus)}>{d.healthStatus}</Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {d.deployedAt ? new Date(d.deployedAt).toLocaleString() : "--"}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => healthCheckMutation.mutate(d.id)}
                        disabled={healthCheckMutation.isPending}
                      >
                        <Activity className="mr-1 h-3 w-3" />
                        Check
                      </Button>
                      {d.status === "live" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => rollbackMutation.mutate(d.id)}
                          disabled={rollbackMutation.isPending}
                        >
                          <RotateCcw className="mr-1 h-3 w-3" />
                          Rollback
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
