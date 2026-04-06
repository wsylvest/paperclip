import { api } from "./client";

export interface SecretProviderConfig {
  id: string;
  companyId: string;
  provider: string;
  status: string;
  config: Record<string, string> | null;
  lastTestedAt: string | null;
  testError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const secretProvidersApi = {
  list: (companyId: string) =>
    api.get<SecretProviderConfig[]>(`/companies/${companyId}/secret-providers`),
  configure: (companyId: string, input: { provider: string; config: Record<string, string> }) =>
    api.post<SecretProviderConfig>(`/companies/${companyId}/secret-providers`, input),
  testConnection: (companyId: string, id: string) =>
    api.post<SecretProviderConfig>(`/companies/${companyId}/secret-providers/${id}/test`, {}),
  remove: (companyId: string, id: string) =>
    api.delete<SecretProviderConfig>(`/companies/${companyId}/secret-providers/${id}`),
};
