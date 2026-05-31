import type {
  McpAuthType,
  McpHealthCheckResult,
  McpInvocation,
  McpPrincipalType,
  McpServer,
  McpServerGrant,
  McpServerSuggestion,
  McpTransport,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CreateMcpServerInput {
  name: string;
  description?: string | null;
  transport: McpTransport;
  endpoint: string;
  authType: McpAuthType;
  authSecretRef?: string | null;
  allowlist?: Record<string, unknown> | null;
  oauthTokenEndpoint?: string | null;
  oauthScopes?: string | null;
  oauthResource?: string | null;
}

export interface UpdateMcpServerInput {
  name?: string;
  description?: string | null;
  transport?: McpTransport;
  endpoint?: string;
  authType?: McpAuthType;
  authSecretRef?: string | null;
  allowlist?: Record<string, unknown> | null;
  oauthTokenEndpoint?: string | null;
  oauthScopes?: string | null;
  oauthResource?: string | null;
}

export interface CreateMcpServerGrantInput {
  mcpServerId: string;
  principalType: McpPrincipalType;
  principalId?: string | null;
  toolAllowlist?: string[] | null;
}

export interface ListMcpInvocationsOptions {
  runId?: string;
  serverId?: string;
  limit?: number;
  beforeId?: string;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (entries.length === 0) return "";
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    search.set(key, String(value));
  }
  return `?${search.toString()}`;
}

export const mcpApi = {
  listServers: (companyId: string) =>
    api.get<McpServer[]>(`/companies/${companyId}/mcp/servers`),
  getServer: (companyId: string, id: string) =>
    api.get<McpServer>(`/companies/${companyId}/mcp/servers/${id}`),
  createServer: (companyId: string, input: CreateMcpServerInput) =>
    api.post<McpServer>(`/companies/${companyId}/mcp/servers`, input),
  updateServer: (companyId: string, id: string, patch: UpdateMcpServerInput) =>
    api.patch<McpServer>(`/companies/${companyId}/mcp/servers/${id}`, patch),
  deleteServer: (companyId: string, id: string) =>
    api.delete<void>(`/companies/${companyId}/mcp/servers/${id}`),
  probeServer: (companyId: string, id: string) =>
    api.post<McpHealthCheckResult>(`/companies/${companyId}/mcp/servers/${id}/probe`, {}),
  listGrants: (companyId: string, serverId?: string) => {
    const query = serverId ? `?serverId=${encodeURIComponent(serverId)}` : "";
    return api.get<McpServerGrant[]>(`/companies/${companyId}/mcp/grants${query}`);
  },
  createGrant: (companyId: string, input: CreateMcpServerGrantInput) =>
    api.post<McpServerGrant>(`/companies/${companyId}/mcp/grants`, input),
  deleteGrant: (companyId: string, id: string) =>
    api.delete<void>(`/companies/${companyId}/mcp/grants/${id}`),
  listInvocations: (companyId: string, opts: ListMcpInvocationsOptions = {}) => {
    const query = buildQuery({
      runId: opts.runId,
      serverId: opts.serverId,
      limit: opts.limit,
      beforeId: opts.beforeId,
    });
    return api.get<McpInvocation[]>(`/companies/${companyId}/mcp/invocations${query}`);
  },
  listSuggestions: (companyId: string) =>
    api.get<McpServerSuggestion[]>(`/companies/${companyId}/mcp/suggestions`),
  installSuggestion: (
    companyId: string,
    key: string,
    input: { endpoint?: string; authSecretRef?: string } = {},
  ) =>
    api.post<McpServer>(
      `/companies/${companyId}/mcp/suggestions/${encodeURIComponent(key)}/install`,
      input,
    ),
};
