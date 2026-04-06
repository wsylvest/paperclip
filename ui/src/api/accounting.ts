import { api } from "./client";

export interface AccountingConnection {
  id: string;
  companyId: string;
  provider: string;
  status: string;
  realmId: string | null;
  tenantId: string | null;
  lastSyncAt: string | null;
  syncError: string | null;
  createdAt: string;
}

export interface SyncLogEntry {
  id: string;
  direction: string;
  entityType: string;
  entityId: string | null;
  externalId: string | null;
  status: string;
  errorDetail: string | null;
  createdAt: string;
}

export const accountingApi = {
  connections: (companyId: string) =>
    api.get<AccountingConnection[]>(`/companies/${companyId}/accounting/connections`),
  connect: (companyId: string, input: { provider: string; redirectUrl: string }) =>
    api.post<{ authorizationUrl: string; state: string }>(`/companies/${companyId}/accounting/connect`, input),
  disconnect: (companyId: string, connectionId: string) =>
    api.delete<AccountingConnection>(`/companies/${companyId}/accounting/connections/${connectionId}`),
  chartOfAccounts: (companyId: string, connectionId: string) =>
    api.get<Record<string, string>[]>(`/companies/${companyId}/accounting/chart-of-accounts/${connectionId}`),
  updateMapping: (companyId: string, connectionId: string, mapping: Record<string, string>) =>
    api.put<AccountingConnection>(`/companies/${companyId}/accounting/mappings/${connectionId}`, { mapping }),
  sync: (companyId: string, input?: { direction?: string; entityType?: string }) =>
    api.post<{ syncedCount: number; errors: string[] }>(`/companies/${companyId}/accounting/sync`, input ?? {}),
  syncLog: (companyId: string) =>
    api.get<SyncLogEntry[]>(`/companies/${companyId}/accounting/sync-log`),
};
