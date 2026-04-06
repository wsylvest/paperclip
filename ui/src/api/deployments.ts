import { api } from "./client";

export interface Deployment {
  id: string;
  companyId: string;
  issueId: string | null;
  agentId: string | null;
  environment: string;
  status: string;
  url: string | null;
  provider: string | null;
  commitSha: string | null;
  healthStatus: string;
  deployedAt: string | null;
  createdAt: string;
}

export const deploymentsApi = {
  list: (companyId: string, status?: string) => {
    const params = status ? `?status=${status}` : "";
    return api.get<Deployment[]>(`/companies/${companyId}/deployments${params}`);
  },
  get: (companyId: string, id: string) =>
    api.get<Deployment>(`/companies/${companyId}/deployments/${id}`),
  create: (companyId: string, input: Record<string, unknown>) =>
    api.post<Deployment>(`/companies/${companyId}/deployments`, input),
  updateStatus: (companyId: string, id: string, input: { status: string; metadata?: Record<string, unknown> }) =>
    api.put<Deployment>(`/companies/${companyId}/deployments/${id}/status`, input),
  rollback: (companyId: string, id: string) =>
    api.post<Deployment>(`/companies/${companyId}/deployments/${id}/rollback`, {}),
  healthCheck: (companyId: string, id: string) =>
    api.post<Deployment>(`/companies/${companyId}/deployments/${id}/health-check`, {}),
};
