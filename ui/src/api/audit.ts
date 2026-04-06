import { api } from "./client";

export interface AuditEvent {
  id: string;
  companyId: string | null;
  actorType: string;
  actorId: string;
  category: string;
  action: string;
  entityType: string;
  entityId: string;
  severity: string;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
  createdAt: string;
}

export interface AuditQueryResult {
  items: AuditEvent[];
  total: number;
}

export interface AuditRetentionPolicy {
  id: string;
  companyId: string | null;
  category: string;
  retentionDays: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ComplianceSummaryItem {
  category: string;
  severity: string;
  count: number;
}

export interface AuditQueryFilters {
  category?: string;
  severity?: string;
  actorType?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export const auditApi = {
  list: (companyId: string, filters?: AuditQueryFilters) => {
    const params = new URLSearchParams();
    if (filters) {
      for (const [key, val] of Object.entries(filters)) {
        if (val != null) params.set(key, String(val));
      }
    }
    const qs = params.toString();
    return api.get<AuditQueryResult>(
      `/companies/${companyId}/audit${qs ? `?${qs}` : ""}`,
    );
  },
  exportCsv: (companyId: string, filters?: { category?: string; severity?: string; from?: string; to?: string }) => {
    const params = new URLSearchParams({ format: "csv" });
    if (filters) {
      for (const [key, val] of Object.entries(filters)) {
        if (val != null) params.set(key, String(val));
      }
    }
    return `/api/companies/${companyId}/audit/export?${params.toString()}`;
  },
  complianceSummary: (companyId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api.get<ComplianceSummaryItem[]>(
      `/companies/${companyId}/audit/compliance-summary${qs ? `?${qs}` : ""}`,
    );
  },
  retentionPolicies: (companyId: string) =>
    api.get<AuditRetentionPolicy[]>(`/companies/${companyId}/audit/retention-policies`),
  upsertRetentionPolicy: (companyId: string, input: { category: string; retentionDays: number; isActive: boolean }) =>
    api.put<AuditRetentionPolicy>(`/companies/${companyId}/audit/retention-policies`, input),
};
