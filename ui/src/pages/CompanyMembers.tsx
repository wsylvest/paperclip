import { useEffect, useState } from "react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Users, ShieldAlert } from "lucide-react";

interface CompanyMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  status: string;
  joinedAt: string;
  lastActiveAt: string | null;
}

const ROLES = ["owner", "admin", "member", "viewer"];

function roleBadgeVariant(role: string): "default" | "secondary" | "outline" {
  switch (role) {
    case "owner":
      return "default";
    case "admin":
      return "secondary";
    default:
      return "outline";
  }
}

export function CompanyMembers() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [transferTarget, setTransferTarget] = useState<CompanyMember | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Members" }]);
  }, [setBreadcrumbs]);

  const membersKey = ["company-members", selectedCompanyId];

  const { data, isLoading, error } = useQuery({
    queryKey: membersKey,
    queryFn: () =>
      api.get<CompanyMember[]>(`/companies/${selectedCompanyId}/members`),
    enabled: !!selectedCompanyId,
  });

  const roleChangeMutation = useMutation({
    mutationFn: ({
      memberId,
      role,
    }: {
      memberId: string;
      role: string;
    }) =>
      api.put(`/companies/${selectedCompanyId}/members/${memberId}/role`, {
        role,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: membersKey });
    },
  });

  const transferOwnershipMutation = useMutation({
    mutationFn: (memberId: string) =>
      api.put(`/companies/${selectedCompanyId}/members/${memberId}/role`, {
        role: "owner",
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: membersKey });
      setTransferTarget(null);
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="Select a company to view members." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return <p className="text-sm text-destructive">{(error as Error).message}</p>;
  }

  if (!data || data.length === 0) {
    return <EmptyState icon={Users} message="No members found." />;
  }

  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 px-3 font-medium">Name</th>
            <th className="py-2 px-3 font-medium">Email</th>
            <th className="py-2 px-3 font-medium">Role</th>
            <th className="py-2 px-3 font-medium">Status</th>
            <th className="py-2 px-3 font-medium">Joined</th>
            <th className="py-2 px-3 font-medium">Last Active</th>
            <th className="py-2 px-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {data.map((member) => (
            <tr key={member.id} className="border-b">
              <td className="py-2 px-3">{member.name}</td>
              <td className="py-2 px-3 text-muted-foreground">{member.email}</td>
              <td className="py-2 px-3">
                <Select
                  value={member.role}
                  onValueChange={(role) =>
                    roleChangeMutation.mutate({ memberId: member.id, role })
                  }
                >
                  <SelectTrigger className="w-[110px] h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r.charAt(0).toUpperCase() + r.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </td>
              <td className="py-2 px-3">
                <Badge variant={member.status === "active" ? "secondary" : "outline"}>
                  {member.status}
                </Badge>
              </td>
              <td className="py-2 px-3 text-muted-foreground">
                {new Date(member.joinedAt).toLocaleDateString()}
              </td>
              <td className="py-2 px-3 text-muted-foreground">
                {member.lastActiveAt
                  ? new Date(member.lastActiveAt).toLocaleDateString()
                  : "-"}
              </td>
              <td className="py-2 px-3">
                {member.role !== "owner" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() => setTransferTarget(member)}
                  >
                    <ShieldAlert className="h-3 w-3 mr-1" />
                    Transfer ownership
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Dialog
        open={!!transferTarget}
        onOpenChange={(open) => {
          if (!open) setTransferTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer Ownership</DialogTitle>
            <DialogDescription>
              Are you sure you want to transfer ownership to{" "}
              <strong>{transferTarget?.name}</strong> ({transferTarget?.email})?
              This action cannot be easily undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={transferOwnershipMutation.isPending}
              onClick={() => {
                if (transferTarget) {
                  transferOwnershipMutation.mutate(transferTarget.id);
                }
              }}
            >
              {transferOwnershipMutation.isPending
                ? "Transferring..."
                : "Confirm Transfer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
