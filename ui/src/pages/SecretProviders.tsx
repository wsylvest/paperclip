import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { secretProvidersApi } from "../api/secretProviders";
import type { SecretProviderConfig } from "../api/secretProviders";
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
import { KeyRound, Plus, TestTube, Trash2 } from "lucide-react";

const PROVIDER_OPTIONS = [
  { value: "aws_secrets_manager", label: "AWS Secrets Manager" },
  { value: "gcp_secret_manager", label: "GCP Secret Manager" },
  { value: "vault", label: "HashiCorp Vault" },
];

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active":
      return "default";
    case "configured":
      return "secondary";
    case "error":
      return "destructive";
    default:
      return "outline";
  }
}

export function SecretProviders() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [provider, setProvider] = useState("aws_secrets_manager");
  const [configKey, setConfigKey] = useState("");
  const [configValue, setConfigValue] = useState("");
  const [configEntries, setConfigEntries] = useState<Record<string, string>>({});

  useEffect(() => {
    setBreadcrumbs([{ label: "Secret Providers" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.secretProviders.list(companyId),
    queryFn: () => secretProvidersApi.list(companyId),
    enabled: !!companyId,
  });

  const configureMutation = useMutation({
    mutationFn: (input: { provider: string; config: Record<string, string> }) =>
      secretProvidersApi.configure(companyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secretProviders.list(companyId) });
      setShowForm(false);
      setConfigEntries({});
      setConfigKey("");
      setConfigValue("");
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => secretProvidersApi.testConnection(companyId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secretProviders.list(companyId) });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => secretProvidersApi.remove(companyId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secretProviders.list(companyId) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={KeyRound} message="Select a company to manage secret providers." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const configs: SecretProviderConfig[] = data ?? [];

  const addConfigEntry = () => {
    if (configKey.trim()) {
      setConfigEntries((prev) => ({ ...prev, [configKey.trim()]: configValue }));
      setConfigKey("");
      setConfigValue("");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Secret Providers</h1>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="mr-2 h-4 w-4" />
          Configure Provider
        </Button>
      </div>

      {showForm && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDER_OPTIONS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Input
              placeholder="Config key"
              value={configKey}
              onChange={(e) => setConfigKey(e.target.value)}
              className="flex-1"
            />
            <Input
              placeholder="Config value"
              value={configValue}
              onChange={(e) => setConfigValue(e.target.value)}
              className="flex-1"
              type="password"
            />
            <Button size="sm" variant="outline" onClick={addConfigEntry}>
              Add
            </Button>
          </div>

          {Object.keys(configEntries).length > 0 && (
            <div className="rounded border p-2 text-xs space-y-1">
              {Object.entries(configEntries).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="font-mono">{k}</span>
                  <span className="text-muted-foreground">{"*".repeat(Math.min(v.length, 8))}</span>
                </div>
              ))}
            </div>
          )}

          <Button
            size="sm"
            onClick={() => configureMutation.mutate({ provider, config: configEntries })}
            disabled={configureMutation.isPending || Object.keys(configEntries).length === 0}
          >
            {configureMutation.isPending ? "Saving..." : "Save Configuration"}
          </Button>
        </div>
      )}

      {configs.length === 0 ? (
        <EmptyState icon={KeyRound} message="No secret providers configured." />
      ) : (
        <div className="rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">Provider</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Last Tested</th>
                <th className="px-4 py-2 text-left font-medium">Error</th>
                <th className="px-4 py-2 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-mono text-xs">
                    {PROVIDER_OPTIONS.find((p) => p.value === c.provider)?.label ?? c.provider}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {c.lastTestedAt ? new Date(c.lastTestedAt).toLocaleString() : "--"}
                  </td>
                  <td className="px-4 py-2 text-xs text-destructive">
                    {c.testError ?? "--"}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => testMutation.mutate(c.id)}
                        disabled={testMutation.isPending}
                      >
                        <TestTube className="mr-1 h-3 w-3" />
                        Test
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeMutation.mutate(c.id)}
                        disabled={removeMutation.isPending}
                      >
                        <Trash2 className="mr-1 h-3 w-3" />
                        Remove
                      </Button>
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
