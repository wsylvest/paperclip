import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { accountingApi } from "../api/accounting";
import type { AccountingConnection, SyncLogEntry } from "../api/accounting";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BookOpen, RefreshCw, Unplug, ExternalLink } from "lucide-react";

function connectionStatusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "connected":
      return "default";
    case "disconnected":
    case "error":
      return "destructive";
    case "pending":
      return "secondary";
    default:
      return "outline";
  }
}

function syncStatusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "success":
      return "default";
    case "error":
      return "destructive";
    case "pending":
      return "secondary";
    default:
      return "outline";
  }
}

const PROVIDERS = [
  { id: "quickbooks_online", name: "QuickBooks Online" },
  { id: "xero", name: "Xero" },
];

export function AccountingIntegration() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Accounting" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const connectionsQuery = useQuery({
    queryKey: queryKeys.accounting.connections(companyId),
    queryFn: () => accountingApi.connections(companyId),
    enabled: !!companyId,
  });

  const syncLogQuery = useQuery({
    queryKey: queryKeys.accounting.syncLog(companyId),
    queryFn: () => accountingApi.syncLog(companyId),
    enabled: !!companyId,
  });

  const connectMutation = useMutation({
    mutationFn: (provider: string) =>
      accountingApi.connect(companyId, {
        provider,
        redirectUrl: window.location.href,
      }),
    onSuccess: (data) => {
      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      }
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (connectionId: string) =>
      accountingApi.disconnect(companyId, connectionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accounting.connections(companyId) });
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => accountingApi.sync(companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accounting.syncLog(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.accounting.connections(companyId) });
    },
  });

  if (!companyId) {
    return <EmptyState icon={BookOpen} message="Select a company to manage accounting integrations." />;
  }

  if (connectionsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const connections: AccountingConnection[] = connectionsQuery.data ?? [];
  const syncLog: SyncLogEntry[] = syncLogQuery.data ?? [];
  const connectedProviders = new Set(connections.map((c) => c.provider));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Accounting Integration</h1>
        {connections.some((c) => c.status === "connected") && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            Sync Now
          </Button>
        )}
      </div>

      {/* Connected Providers */}
      {connections.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Connected Accounts</h2>
          <div className="space-y-2">
            {connections.map((conn) => (
              <div
                key={conn.id}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3"
              >
                <BookOpen className="h-4 w-4 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium capitalize">
                      {conn.provider.replace(/_/g, " ")}
                    </span>
                    <Badge variant={connectionStatusVariant(conn.status)}>
                      {conn.status}
                    </Badge>
                  </div>
                  {conn.lastSyncAt && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Last synced: {new Date(conn.lastSyncAt).toLocaleString()}
                    </p>
                  )}
                  {conn.syncError && (
                    <p className="text-xs text-destructive mt-0.5">{conn.syncError}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => disconnectMutation.mutate(conn.id)}
                  disabled={disconnectMutation.isPending}
                >
                  <Unplug className="h-3.5 w-3.5 mr-1" />
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Connect New Provider */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">Connect a Provider</h2>
        <div className="flex gap-3">
          {PROVIDERS.map((provider) => (
            <Button
              key={provider.id}
              variant="outline"
              size="sm"
              disabled={connectedProviders.has(provider.id) || connectMutation.isPending}
              onClick={() => connectMutation.mutate(provider.id)}
            >
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              {connectedProviders.has(provider.id) ? `${provider.name} (connected)` : `Connect ${provider.name}`}
            </Button>
          ))}
        </div>
      </div>

      {/* Sync Log */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">Sync Log</h2>
        {syncLogQuery.isLoading && <PageSkeleton variant="list" />}
        {syncLog.length === 0 && !syncLogQuery.isLoading && (
          <EmptyState icon={RefreshCw} message="No sync history yet." />
        )}
        {syncLog.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">Time</th>
                  <th className="px-4 py-2 text-left font-medium">Direction</th>
                  <th className="px-4 py-2 text-left font-medium">Entity Type</th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {syncLog.map((entry) => (
                  <tr key={entry.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2">{entry.direction}</td>
                    <td className="px-4 py-2">{entry.entityType}</td>
                    <td className="px-4 py-2">
                      <Badge variant={syncStatusVariant(entry.status)}>
                        {entry.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground text-xs max-w-xs truncate">
                      {entry.errorDetail ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {syncMutation.isSuccess && syncMutation.data && (
        <div className="rounded-md border border-border bg-card p-3 text-sm">
          Synced {syncMutation.data.syncedCount} records.
          {syncMutation.data.errors.length > 0 && (
            <span className="text-destructive ml-2">
              {syncMutation.data.errors.length} error(s): {syncMutation.data.errors.join(", ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
