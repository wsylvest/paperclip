import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { adminApi } from "../api/admin";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  Building2,
  Users,
  Bot,
  DollarSign,
  AlertCircle,
  Activity,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

function MetricTile({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border p-4 bg-card">
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

export function AdminDashboard() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Admin Dashboard" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.admin.overview,
    queryFn: () => adminApi.overview(),
  });

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  if (!data) {
    return null;
  }

  const formatDollars = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <MetricTile
          icon={Building2}
          label="Companies"
          value={data.companyCount}
        />
        <MetricTile icon={Users} label="Users" value={data.userCount} />
        <MetricTile icon={Bot} label="Agents" value={data.agentCount} />
        <MetricTile
          icon={DollarSign}
          label="Total Spend"
          value={formatDollars(data.totalSpendCents)}
        />
        <MetricTile
          icon={Activity}
          label="Active Agents"
          value={data.activeAgentCount}
        />
        <MetricTile
          icon={AlertCircle}
          label="Pending Approvals"
          value={data.pendingApprovalCount}
        />
      </div>
    </div>
  );
}
