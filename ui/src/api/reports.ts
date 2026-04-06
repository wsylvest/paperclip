import { api } from "./client";

export interface CostTimeSeriesPoint {
  period: string;
  costCents: number;
  eventCount: number;
}

export interface AgentPerformanceRow {
  agentId: string;
  agentName: string;
  tasksCompleted: number;
  avgResolutionHours: number | null;
  totalCostCents: number;
  successRate: number;
}

export interface UserActivityRow {
  userId: string;
  actionCount: number;
  lastActiveAt: string | null;
  topActions: string[];
}

export const reportsApi = {
  costTimeSeries: (companyId: string, from?: string, to?: string, granularity?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (granularity) params.set("granularity", granularity);
    const qs = params.toString();
    return api.get<CostTimeSeriesPoint[]>(`/companies/${companyId}/reports/cost-time-series${qs ? `?${qs}` : ""}`);
  },
  agentPerformance: (companyId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api.get<AgentPerformanceRow[]>(`/companies/${companyId}/reports/agent-performance${qs ? `?${qs}` : ""}`);
  },
  userActivity: (companyId: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api.get<UserActivityRow[]>(`/companies/${companyId}/reports/user-activity${qs ? `?${qs}` : ""}`);
  },
};
