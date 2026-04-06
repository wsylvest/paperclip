import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { adminApi } from "../api/admin";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";

export function AdminUsers() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Admin Dashboard", href: "/admin" }, { label: "Users" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.admin.users,
    queryFn: () => adminApi.users(),
  });

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">{error.message}</p>;
  }

  if (!data || data.length === 0) {
    return <EmptyState icon={Users} message="No users found." />;
  }

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 px-3 font-medium">Name</th>
            <th className="py-2 px-3 font-medium">Email</th>
            <th className="py-2 px-3 font-medium">Instance Admin</th>
            <th className="py-2 px-3 font-medium">Companies</th>
            <th className="py-2 px-3 font-medium">Joined</th>
          </tr>
        </thead>
        <tbody>
          {data.map((user) => (
            <tr key={user.userId} className="border-b">
              <td className="py-2 px-3">{user.name}</td>
              <td className="py-2 px-3 text-muted-foreground">{user.email}</td>
              <td className="py-2 px-3">
                {user.isInstanceAdmin && (
                  <Badge variant="default">Admin</Badge>
                )}
              </td>
              <td className="py-2 px-3 text-muted-foreground">
                {user.memberships
                  .map((m) => `${m.companyName} (${m.role})`)
                  .join(", ") || "-"}
              </td>
              <td className="py-2 px-3 text-muted-foreground">
                {new Date(user.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
