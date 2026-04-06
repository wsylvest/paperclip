import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { adminApi } from "../api/admin";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Building2 } from "lucide-react";

export function AdminCompanies() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Admin Dashboard", href: "/admin" }, { label: "Companies" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.admin.companies,
    queryFn: () => adminApi.companies(),
  });

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  if (!data || data.length === 0) {
    return <EmptyState icon={Building2} message="No companies found." />;
  }

  const formatDollars = (cents: number) =>
    `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 px-3 font-medium">Name</th>
            <th className="py-2 px-3 font-medium">Prefix</th>
            <th className="py-2 px-3 font-medium">Agents</th>
            <th className="py-2 px-3 font-medium">Members</th>
            <th className="py-2 px-3 font-medium">Month Spend</th>
            <th className="py-2 px-3 font-medium">Last Activity</th>
          </tr>
        </thead>
        <tbody>
          {data.map((company) => (
            <tr key={company.companyId} className="border-b">
              <td className="py-2 px-3">{company.companyName}</td>
              <td className="py-2 px-3 text-muted-foreground">
                {company.companyPrefix}
              </td>
              <td className="py-2 px-3 text-muted-foreground">
                {company.activeAgentCount}/{company.agentCount}
              </td>
              <td className="py-2 px-3 text-muted-foreground">
                {company.memberCount}
              </td>
              <td className="py-2 px-3 text-muted-foreground">
                {formatDollars(company.monthSpendCents)}
              </td>
              <td className="py-2 px-3 text-muted-foreground">
                {company.lastActivityAt
                  ? new Date(company.lastActivityAt).toLocaleDateString()
                  : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
