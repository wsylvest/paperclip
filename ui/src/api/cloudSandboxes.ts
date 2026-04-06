import { api } from "./client";

export interface CloudSandbox {
  id: string;
  companyId: string;
  agentId: string | null;
  provider: string;
  status: string;
  templateId: string | null;
  region: string | null;
  costAccumulatedCents: number;
  expiresAt: string | null;
  createdAt: string;
}

export const cloudSandboxesApi = {
  list: (companyId: string) =>
    api.get<CloudSandbox[]>(`/companies/${companyId}/sandboxes`),
  provision: (companyId: string, input: { provider: string; templateId?: string; region?: string; agentId?: string }) =>
    api.post<CloudSandbox>(`/companies/${companyId}/sandboxes`, input),
  terminate: (companyId: string, id: string) =>
    api.delete<CloudSandbox>(`/companies/${companyId}/sandboxes/${id}`),
  extend: (companyId: string, id: string, additionalSeconds: number) =>
    api.post<CloudSandbox>(`/companies/${companyId}/sandboxes/${id}/extend`, { additionalSeconds }),
};
