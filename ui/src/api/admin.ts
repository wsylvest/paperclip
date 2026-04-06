import { api } from "./client";

export interface InstanceOverview {
  companyCount: number;
  userCount: number;
  agentCount: number;
  totalSpendCents: number;
  activeAgentCount: number;
  pendingApprovalCount: number;
}

export interface CompanyHealthSummary {
  companyId: string;
  companyName: string;
  companyPrefix: string;
  agentCount: number;
  activeAgentCount: number;
  memberCount: number;
  monthSpendCents: number;
  lastActivityAt: string | null;
}

export interface UserManagement {
  userId: string;
  name: string;
  email: string;
  isInstanceAdmin: boolean;
  memberships: {
    companyId: string;
    companyName: string;
    role: string;
    status: string;
  }[];
  createdAt: string;
}

export const adminApi = {
  overview: () => api.get<InstanceOverview>("/admin/overview"),
  companies: () => api.get<CompanyHealthSummary[]>("/admin/companies"),
  users: () => api.get<UserManagement[]>("/admin/users"),
};
