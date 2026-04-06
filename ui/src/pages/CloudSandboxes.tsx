import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cloudSandboxesApi } from "../api/cloudSandboxes";
import type { CloudSandbox } from "../api/cloudSandboxes";
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
import { Cloud, Trash2, Plus } from "lucide-react";

function sandboxStatusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "running":
      return "default";
    case "provisioning":
      return "secondary";
    case "paused":
      return "outline";
    case "terminated":
    case "error":
      return "destructive";
    default:
      return "outline";
  }
}

export function CloudSandboxes() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [provider, setProvider] = useState("e2b");
  const [region, setRegion] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Cloud Sandboxes" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.sandboxes.list(companyId),
    queryFn: () => cloudSandboxesApi.list(companyId),
    enabled: !!companyId,
  });

  const provisionMutation = useMutation({
    mutationFn: (input: { provider: string; region?: string }) =>
      cloudSandboxesApi.provision(companyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.list(companyId) });
      setShowForm(false);
      setRegion("");
    },
  });

  const terminateMutation = useMutation({
    mutationFn: (id: string) => cloudSandboxesApi.terminate(companyId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.list(companyId) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Cloud} message="Select a company to view sandboxes." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const sandboxes: CloudSandbox[] = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cloud Sandboxes</h1>
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="mr-1 h-3 w-3" />
          Provision
        </Button>
      </div>

      {showForm && (
        <div className="rounded-md border border-border bg-card p-4 space-y-3">
          <h2 className="text-sm font-medium">Provision New Sandbox</h2>
          <div className="flex gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Provider</label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="e2b">e2b</SelectItem>
                  <SelectItem value="fly_machines">fly_machines</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Region (optional)</label>
              <Input
                placeholder="us-east-1"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="w-[180px]"
              />
            </div>
            <Button
              size="sm"
              onClick={() =>
                provisionMutation.mutate({
                  provider,
                  ...(region ? { region } : {}),
                })
              }
              disabled={provisionMutation.isPending}
            >
              {provisionMutation.isPending ? "Provisioning..." : "Create"}
            </Button>
          </div>
        </div>
      )}

      {sandboxes.length === 0 ? (
        <EmptyState icon={Cloud} message="No active sandboxes." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sandboxes.map((sb) => (
            <div key={sb.id} className="rounded-md border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between">
                <Badge variant={sandboxStatusVariant(sb.status)}>{sb.status}</Badge>
                <span className="text-xs text-muted-foreground font-mono">{sb.provider}</span>
              </div>
              <div className="text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cost</span>
                  <span>${(sb.costAccumulatedCents / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Region</span>
                  <span>{sb.region ?? "--"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Expires</span>
                  <span>
                    {sb.expiresAt ? new Date(sb.expiresAt).toLocaleString() : "--"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Created</span>
                  <span>{new Date(sb.createdAt).toLocaleString()}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="destructive"
                className="w-full"
                onClick={() => terminateMutation.mutate(sb.id)}
                disabled={terminateMutation.isPending}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Terminate
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
