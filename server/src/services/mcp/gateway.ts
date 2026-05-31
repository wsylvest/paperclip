/**
 * MCP gateway: accepts JSON-RPC requests from agent CLIs and fans them out
 * to registered upstream MCP servers based on grant configuration.
 *
 * Supported methods:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *   - notifications/initialized  (no-op)
 *
 * Tool names are prefixed with `${serverName}__` in the merged catalog to
 * avoid collisions across upstreams.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, mcpInvocations, mcpServerGrants, mcpServers } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { publishLiveEvent } from "../live-events.js";
import { costService } from "../costs.js";
import { acquireClient } from "./client-pool.js";
import { createSession, broadcastToSession } from "./sessions.js";

// TTL for approved_pending_retry records: 1 hour in milliseconds
const APPROVAL_RETRY_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18";
const GATEWAY_SERVER_INFO = { name: "paperclip-mcp-gateway", version: "0.1.0" };
const JSONRPC_VERSION = "2.0";

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function successResponse(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined || req.id === null;
}

// ---------------------------------------------------------------------------
// Grant resolution logic
// ---------------------------------------------------------------------------

interface GrantRow {
  principalType: string;
  principalId: string | null;
  toolAllowlist: string[] | null | unknown;
  requireApprovalTools?: string[] | null | unknown;
}

function normalizeAllowlist(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw as string[];
  return null;
}

export function canPrincipalCallTool(
  grants: GrantRow[],
  serverAllowlist: string[] | null,
  agentId: string,
  toolName: string,
): boolean {
  const relevant = grants.filter(
    (g) =>
      (g.principalType === "agent" && g.principalId === agentId) ||
      g.principalType === "company",
  );

  if (relevant.length === 0) return false;

  for (const grant of relevant) {
    const grantAllowlist = normalizeAllowlist(grant.toolAllowlist);

    if (grantAllowlist === null) {
      // Inherit server allowlist
      if (serverAllowlist === null || serverAllowlist.includes(toolName)) {
        return true;
      }
    } else if (grantAllowlist.length === 0) {
      // Explicit deny — continue to check other grants
      continue;
    } else {
      // Grant has explicit list
      if (grantAllowlist.includes(toolName)) {
        if (serverAllowlist === null || serverAllowlist.includes(toolName)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Returns whether the most-specific grant for the calling agent has this tool
 * listed in `requireApprovalTools`. Agent-specific grants beat company-wide
 * grants (first match in priority order wins).
 */
export function doesToolRequireApproval(
  grants: GrantRow[],
  agentId: string,
  toolName: string,
): boolean {
  // Sort: agent-specific first, then company-wide
  const relevant = grants
    .filter(
      (g) =>
        (g.principalType === "agent" && g.principalId === agentId) ||
        g.principalType === "company",
    )
    .sort((a) => (a.principalType === "agent" ? -1 : 1));

  for (const grant of relevant) {
    const requireList = normalizeAllowlist(grant.requireApprovalTools);
    if (requireList === null) continue; // null = not configured for this grant
    return requireList.includes(toolName);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

function hashPayload(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

/**
 * The gateway route calls handleGatewayRequest and consumes this return type.
 * When the request was an `initialize`, `sessionId` is set so the route can
 * emit the `Mcp-Session-Id` response header before writing the JSON body.
 *
 * Design rationale: the route is responsible for headers, but the gateway
 * service is responsible for creating the session record (it has the context
 * about companyId/agentId/runId). The route inspects `sessionId` on the
 * returned wrapper and calls res.set() before res.json().
 */
export interface GatewayResponse {
  result: unknown;
  sessionId?: string;
}

export async function handleGatewayRequest(opts: {
  db: Db;
  companyId: string;
  agentId: string;
  /**
   * The heartbeat run id associated with this request, if available.
   * Used for cost attribution. Threaded from the gateway route via the
   * X-Paperclip-Run-Id header that adapters emit when they materialize each
   * CLI's MCP config. The header is validated to belong to this agent in
   * this company; mismatches are silently treated as null. Codex CLI does
   * not have a per-server headers map so Codex runs still arrive with
   * runId=null until that gap is closed by the upstream CLI.
   */
  runId?: string | null;
  /**
   * When the caller has already associated this request with a live SSE
   * session (via the Mcp-Session-Id request header), pass the id here so
   * tools/call can route upstream progress notifications to the session
   * stream.
   */
  sessionId?: string | null;
  body: unknown;
}): Promise<GatewayResponse | null> {
  const { db, companyId, agentId, runId = null, sessionId = null, body } = opts;

  // Batch support: array of requests
  if (Array.isArray(body)) {
    const results = await Promise.all(
      body.map((item) =>
        dispatchSingle(db, companyId, agentId, runId, sessionId, item).then((r) => r ?? undefined),
      ),
    );
    // Filter out undefined (notifications)
    const filtered = results.filter((r) => r !== undefined);
    if (filtered.length === 0) return null;
    return { result: filtered };
  }

  const rpcResult = await dispatchSingle(db, companyId, agentId, runId, sessionId, body);
  if (rpcResult === undefined) return null;

  // Extract session id attached by the initialize handler.
  const mintedSessionId = (rpcResult as unknown as { _sessionId?: string })._sessionId;
  if (mintedSessionId !== undefined) {
    // Clean the internal marker off the outgoing JSON-RPC response.
    delete (rpcResult as unknown as { _sessionId?: string })._sessionId;
    return { result: rpcResult, sessionId: mintedSessionId };
  }

  return { result: rpcResult };
}

async function dispatchSingle(
  db: Db,
  companyId: string,
  agentId: string,
  runId: string | null,
  sessionId: string | null,
  rawReq: unknown,
): Promise<JsonRpcResponse | undefined> {
  // Validate shape
  if (typeof rawReq !== "object" || rawReq === null || !("method" in rawReq)) {
    return errorResponse(null, -32600, "Invalid Request");
  }

  const req = rawReq as JsonRpcRequest;
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize": {
        // Mint a session so the caller can open a GET /mcp/rpc SSE stream.
        // The session id is returned in the wrapper and the route sets the
        // Mcp-Session-Id response header before flushing the JSON body.
        // We store it in the rawReq handler's closure via the outer `sessionId`
        // variable — but since initialize always creates a NEW session we
        // override any incoming sessionId here.
        const newSessionId = createSession({ companyId, agentId, runId });
        const initResp = handleInitialize(id);
        // Attach session id as metadata on the response object so the
        // wrapping GatewayResponse layer can surface it.
        (initResp as unknown as { _sessionId: string })._sessionId = newSessionId;
        return initResp;
      }

      case "notifications/initialized":
        // No-op notification: return undefined per JSON-RPC spec
        return undefined;

      case "tools/list":
        return successResponse(id, await handleToolsList(db, companyId, agentId));

      case "tools/call":
        return successResponse(
          id,
          await handleToolsCall(db, companyId, agentId, runId, sessionId, req.params),
        );

      default:
        return errorResponse(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    if (err instanceof GatewayApprovalPendingError) {
      return errorResponse(id, -32000, "approval pending", {
        approvalId: err.approvalId,
        mcpInvocationId: err.mcpInvocationId,
        hint: "retry this tool call after approval; the gateway will deduplicate",
      });
    }
    if (err instanceof GatewayDeniedError) {
      return errorResponse(id, -32000, `denied: ${err.message}`);
    }
    const message = err instanceof Error ? err.message : "Internal error";
    return errorResponse(id, -32000, message);
  }
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

function handleInitialize(id: string | number | null): JsonRpcSuccess {
  return successResponse(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: GATEWAY_SERVER_INFO,
  });
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

/**
 * Returns the merged MCP tool catalog for the given agent, applying server-
 * level and grant-level access rules.  Tool names are prefixed with
 * `${serverName}__${toolName}` so they are unambiguous across upstreams.
 *
 * Exported so the skill-analysis service can populate `availableMcpTools`
 * without duplicating the grant-resolution logic.
 */
export async function listMcpToolsForAgent(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ tools: Array<Record<string, unknown>> }> {
  const servers = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.companyId, companyId));

  if (servers.length === 0) return { tools: [] };

  const grants = await db
    .select()
    .from(mcpServerGrants)
    .where(eq(mcpServerGrants.companyId, companyId));

  const merged: Array<Record<string, unknown>> = [];

  for (const server of servers) {
    const serverGrants = grants.filter((g) => g.mcpServerId === server.id);
    const hasAccess = serverGrants.some(
      (g) =>
        (g.principalType === "agent" && g.principalId === agentId) ||
        g.principalType === "company",
    );
    if (!hasAccess) continue;

    // Get the server allowlist (list of tool names permitted at server level)
    const serverAllowlist = resolveServerAllowlist(server.allowlist);

    let pooled;
    try {
      pooled = await acquireClient(db, companyId, server.id);
    } catch {
      // Skip degraded upstreams; don't fail the whole list
      continue;
    }

    for (const tool of pooled.toolList.tools) {
      if (!canPrincipalCallTool(serverGrants, serverAllowlist, agentId, tool.name)) {
        continue;
      }
      merged.push({
        ...(tool as Record<string, unknown>),
        name: `${server.name}__${tool.name}`,
        description: (tool as { description?: string }).description
          ? `[${server.name}] ${(tool as { description: string }).description}`
          : `[${server.name}]`,
      });
    }
  }

  return { tools: merged };
}

async function handleToolsList(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ tools: unknown[] }> {
  return listMcpToolsForAgent(db, companyId, agentId);
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

class GatewayDeniedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "GatewayDeniedError";
  }
}

async function handleToolsCall(
  db: Db,
  companyId: string,
  agentId: string,
  runId: string | null,
  sessionId: string | null,
  params: unknown,
): Promise<unknown> {
  if (typeof params !== "object" || params === null || !("name" in params)) {
    throw new Error("tools/call: params.name is required");
  }

  const { name: prefixedName, arguments: toolArgs = {} } = params as {
    name: string;
    arguments?: unknown;
  };

  // Parse server name and tool name from prefix
  const separatorIdx = prefixedName.indexOf("__");
  if (separatorIdx === -1) {
    throw new GatewayDeniedError(`Tool name '${prefixedName}' is missing server prefix (expected format: serverName__toolName)`);
  }
  const serverName = prefixedName.slice(0, separatorIdx);
  const toolName = prefixedName.slice(separatorIdx + 2);

  // Resolve server by name in this company
  const server = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.companyId, companyId), eq(mcpServers.name, serverName)))
    .then((rows) => rows[0] ?? null);

  if (!server) {
    throw new GatewayDeniedError(`Server '${serverName}' not found in company`);
  }

  // Check grants
  const grants = await db
    .select()
    .from(mcpServerGrants)
    .where(
      and(eq(mcpServerGrants.companyId, companyId), eq(mcpServerGrants.mcpServerId, server.id)),
    );

  const serverAllowlist = resolveServerAllowlist(server.allowlist);

  if (!canPrincipalCallTool(grants, serverAllowlist, agentId, toolName)) {
    // Insert denied invocation row
    const invId = randomUUID();
    const requestHash = hashPayload(toolArgs);
    await db.insert(mcpInvocations).values({
      id: invId,
      companyId,
      agentId,
      runId: runId ?? null,
      mcpServerId: server.id,
      toolName,
      requestPayloadHash: requestHash,
      status: "denied",
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "mcp_invocation.denied",
      entityType: "mcp_invocation",
      entityId: invId,
      details: { serverName, toolName },
    });

    throw new GatewayDeniedError(`Agent is not permitted to call tool '${toolName}' on server '${serverName}'`);
  }

  const requestHash = hashPayload(toolArgs);

  // ---------------------------------------------------------------------------
  // Approved-pending-retry bypass: check FIRST if there's a live approved
  // record for this exact payload hash. This runs before the approval gate so
  // that an operator-approved retry goes through even on gated tools.
  // ---------------------------------------------------------------------------
  const bypassResult = await checkApprovedPendingRetry(db, {
    companyId,
    agentId,
    serverId: server.id,
    toolName,
    requestHash,
  });
  if (bypassResult) {
    // Consume the approved_pending_retry row — transition to pending so the
    // real call outcome can update it to succeeded/failed
    await db
      .update(mcpInvocations)
      .set({ status: "pending" })
      .where(eq(mcpInvocations.id, bypassResult.invocationId));
    // Execute the real call with the existing invocation id
    return executeToolCall(db, {
      companyId,
      agentId,
      runId,
      sessionId,
      server,
      serverName,
      toolName,
      toolArgs,
      invId: bypassResult.invocationId,
    });
  }

  // ---------------------------------------------------------------------------
  // Approval gating: check if this tool requires board approval
  // ---------------------------------------------------------------------------
  if (doesToolRequireApproval(grants, agentId, toolName)) {
    return handleApprovalGating(db, {
      companyId,
      agentId,
      runId,
      serverId: server.id,
      serverName,
      toolName,
      requestHash,
      toolArgs,
    });
  }

  // Create pending invocation row
  const invId = randomUUID();
  await db.insert(mcpInvocations).values({
    id: invId,
    companyId,
    agentId,
    runId: runId ?? null,
    mcpServerId: server.id,
    toolName,
    requestPayloadHash: requestHash,
    status: "pending",
    startedAt: new Date(),
  });

  await logActivity(db, {
    companyId,
    actorType: "agent",
    actorId: agentId,
    agentId,
    action: "mcp_invocation.started",
    entityType: "mcp_invocation",
    entityId: invId,
    details: { serverName, toolName },
  });

  return executeToolCall(db, {
    companyId,
    agentId,
    runId,
    sessionId,
    server,
    serverName,
    toolName,
    toolArgs,
    invId,
  });
}

// ---------------------------------------------------------------------------
// executeToolCall — acquires client and dispatches; shared by normal and bypass paths
// ---------------------------------------------------------------------------

async function executeToolCall(
  db: Db,
  opts: {
    companyId: string;
    agentId: string;
    runId: string | null;
    /**
     * The Mcp-Session-Id associated with this call, if any. When set,
     * upstream progress notifications are forwarded to the session SSE
     * stream via broadcastToSession.
     */
    sessionId: string | null;
    server: { id: string; surchargeMicrocents: number };
    serverName: string;
    toolName: string;
    toolArgs: unknown;
    invId: string;
  },
): Promise<unknown> {
  const { companyId, agentId, runId, sessionId, server, toolName, toolArgs, invId } = opts;

  // Acquire client and call tool
  let pooled;
  try {
    pooled = await acquireClient(db, companyId, server.id);
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    await db
      .update(mcpInvocations)
      .set({ status: "failed", errorClass, finishedAt: new Date() })
      .where(eq(mcpInvocations.id, invId));
    throw err;
  }

  try {
    // Per-call progress handler (option a): the SDK's RequestOptions exposes
    // `onprogress` which is called for each notifications/progress message
    // emitted by the upstream server during this specific call. We use this
    // rather than a shared fallbackNotificationHandler so that progress events
    // are routed to the correct session without broadcast fan-out.
    //
    // TODO: for notification types other than notifications/progress (e.g.
    // notifications/message / log) the SDK does not expose per-call handlers;
    // those would require a fallbackNotificationHandler on the pooled client
    // which would need to broadcast to all active sessions for this server
    // (option b). Left as a future TODO.
    const callOptions = sessionId
      ? {
          onprogress: (progress: unknown) => {
            broadcastToSession(sessionId, {
              event: "message",
              data: JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: progress,
              }),
            });
          },
        }
      : undefined;

    const result = await pooled.client.callTool({ name: toolName, arguments: toolArgs }, undefined, callOptions);
    const responseHash = hashPayload(result);
    const costMicrocents = server.surchargeMicrocents ?? 0;

    await db
      .update(mcpInvocations)
      .set({ status: "succeeded", responsePayloadHash: responseHash, finishedAt: new Date(), costMicrocents })
      .where(eq(mcpInvocations.id, invId));

    // Reset consecutive failures on success
    pooled.consecutiveFails = 0;

    // Fan out to cost_events so the existing budget hard-stop evaluates this call.
    // costCents = ceil(microcents / 10_000): 10_000 microcents = 1 cent.
    // heartbeatRunId is null when the gateway route could not validate the
    // X-Paperclip-Run-Id header (missing, malformed, or refers to a run that
    // doesn't belong to this agent).
    if (costMicrocents > 0) {
      const costCents = Math.ceil(costMicrocents / 10_000);
      await costService(db).createEvent(companyId, {
        agentId,
        heartbeatRunId: runId ?? null,
        provider: "mcp_gateway",
        biller: "paperclip",
        billingType: "mcp_tool_call",
        model: toolName,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costCents,
        occurredAt: new Date(),
      });
    }

    return result;
  } catch (err) {
    const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
    pooled.consecutiveFails = (pooled.consecutiveFails ?? 0) + 1;

    await db
      .update(mcpInvocations)
      .set({ status: "failed", errorClass, finishedAt: new Date() })
      .where(eq(mcpInvocations.id, invId));

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Approval gating helpers
// ---------------------------------------------------------------------------

/**
 * GatewayApprovalPendingError is thrown (and caught in dispatchSingle) when a
 * tool call is intercepted for approval. It carries the data needed to build
 * the JSON-RPC -32000 response.
 */
export class GatewayApprovalPendingError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly mcpInvocationId: string,
    toolName: string,
  ) {
    super(`approval pending for tool '${toolName}'`);
    this.name = "GatewayApprovalPendingError";
  }
}

async function handleApprovalGating(
  db: Db,
  opts: {
    companyId: string;
    agentId: string;
    runId: string | null;
    serverId: string;
    serverName: string;
    toolName: string;
    requestHash: string;
    toolArgs: unknown;
  },
): Promise<never> {
  const { companyId, agentId, runId, serverId, serverName, toolName, requestHash, toolArgs } = opts;

  // Check if there's already an approval_pending row for this exact hash
  // (handles concurrent duplicate calls)
  const existingRows = await db
    .select()
    .from(mcpInvocations)
    .where(
      and(
        eq(mcpInvocations.companyId, companyId),
        eq(mcpInvocations.agentId, agentId),
        eq(mcpInvocations.mcpServerId, serverId),
        eq(mcpInvocations.toolName, toolName),
        eq(mcpInvocations.requestPayloadHash, requestHash),
        eq(mcpInvocations.status, "approval_pending"),
      ),
    );

  const existing = (existingRows as Array<{ id: string; approvalId: string | null }>)[0];

  if (existing && existing.approvalId) {
    throw new GatewayApprovalPendingError(existing.approvalId, existing.id, toolName);
  }

  // Create the mcp_invocations row
  const invId = randomUUID();
  const approvalId = randomUUID();
  const now = new Date();

  // Serialize at most 2KB of arguments as the preview
  const argsJson = JSON.stringify(toolArgs ?? {});
  const previewBytes = Buffer.from(argsJson).slice(0, 2048);
  const requestPayloadPreview = previewBytes.toString("base64");

  await db.insert(mcpInvocations).values({
    id: invId,
    companyId,
    agentId,
    runId: runId ?? null,
    mcpServerId: serverId,
    toolName,
    requestPayloadHash: requestHash,
    status: "approval_pending",
    startedAt: now,
    finishedAt: null,
    approvalId,
    costMicrocents: 0,
  });

  // Create the approvals row
  await db.insert(approvals).values({
    id: approvalId,
    companyId,
    type: "mcp_tool_call",
    requestedByAgentId: agentId,
    status: "pending",
    payload: {
      mcpInvocationId: invId,
      mcpServerId: serverId,
      serverName,
      toolName,
      agentId,
      requestPayloadPreview,
    },
  });

  await logActivity(db, {
    companyId,
    actorType: "agent",
    actorId: agentId,
    agentId,
    action: "mcp_tool_call.approval_requested",
    entityType: "mcp_invocation",
    entityId: invId,
    details: { serverName, toolName, approvalId },
  });

  throw new GatewayApprovalPendingError(approvalId, invId, toolName);
}

/**
 * Checks for a live `approved_pending_retry` row matching the given payload
 * hash. Returns the invocation id if found and within TTL, null otherwise.
 */
async function checkApprovedPendingRetry(
  db: Db,
  opts: {
    companyId: string;
    agentId: string;
    serverId: string;
    toolName: string;
    requestHash: string;
  },
): Promise<{ invocationId: string } | null> {
  const { companyId, agentId, serverId, toolName, requestHash } = opts;
  const ttlCutoff = new Date(Date.now() - APPROVAL_RETRY_TTL_MS);

  const rows = await db
    .select()
    .from(mcpInvocations)
    .where(
      and(
        eq(mcpInvocations.companyId, companyId),
        eq(mcpInvocations.agentId, agentId),
        eq(mcpInvocations.mcpServerId, serverId),
        eq(mcpInvocations.toolName, toolName),
        eq(mcpInvocations.requestPayloadHash, requestHash),
        eq(mcpInvocations.status, "approved_pending_retry"),
      ),
    );

  const row = (
    rows as Array<{ id: string; finishedAt: Date | null }>
  )[0];

  if (!row) return null;
  // Check TTL: finishedAt is set when the approval resolved
  if (row.finishedAt && row.finishedAt < ttlCutoff) return null;

  return { invocationId: row.id };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveServerAllowlist(allowlist: Record<string, unknown> | null | undefined): string[] | null {
  if (!allowlist) return null;
  // Allowlist stored as { tools: string[] } in the JSONB column
  const tools = (allowlist as Record<string, unknown>).tools;
  if (Array.isArray(tools)) return tools as string[];
  return null;
}
