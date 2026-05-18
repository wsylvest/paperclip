export type McpTransport = "stdio" | "streamable_http" | "sse_legacy";
export type McpAuthType = "none" | "bearer_ref" | "oauth_ref" | "signed_jwt";
export type McpHealthStatus = "healthy" | "degraded" | "dead" | "unknown";
export type McpPrincipalType = "agent" | "routine" | "project" | "company";
export type McpInvocationStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "denied"
  | "approval_pending"
  | "approved_pending_retry";

export interface McpServer {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  transport: McpTransport;
  endpoint: string;
  authType: McpAuthType;
  authSecretRef: string | null;
  capabilities: Record<string, unknown> | null;
  allowlist: Record<string, unknown> | null;
  healthStatus: McpHealthStatus;
  healthCheckedAt: Date | string | null;
  consecutiveFails: number;
  surchargeMicrocents: number;
  /** OAuth 2.1 Client Credentials token endpoint (authType='oauth_ref') */
  oauthTokenEndpoint: string | null;
  /** Space-separated OAuth scopes */
  oauthScopes: string | null;
  /** RFC 8707 resource indicator; defaults to endpoint when null */
  oauthResource: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface McpServerGrant {
  id: string;
  companyId: string;
  mcpServerId: string;
  principalType: McpPrincipalType;
  principalId: string | null;
  toolAllowlist: string[] | null;
  requireApprovalTools: string[] | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface McpInvocation {
  id: string;
  companyId: string;
  runId: string | null;
  agentId: string | null;
  mcpServerId: string;
  toolName: string;
  requestPayloadHash: string | null;
  responsePayloadHash: string | null;
  startedAt: Date | string;
  finishedAt: Date | string | null;
  status: McpInvocationStatus;
  errorClass: string | null;
  costMicrocents: number;
  approvalId: string | null;
}

export interface McpHealthCheckResult {
  status: McpHealthStatus;
  checkedAt: Date | string;
  consecutiveFails: number;
  message?: string | null;
  latencyMs?: number | null;
}
