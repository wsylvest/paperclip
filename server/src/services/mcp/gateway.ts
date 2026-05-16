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
import { mcpInvocations, mcpServerGrants, mcpServers } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { acquireClient } from "./client-pool.js";

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

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

function hashPayload(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function handleGatewayRequest(opts: {
  db: Db;
  companyId: string;
  agentId: string;
  body: unknown;
}): Promise<unknown> {
  const { db, companyId, agentId, body } = opts;

  // Batch support: array of requests
  if (Array.isArray(body)) {
    const results = await Promise.all(
      body.map((item) =>
        dispatchSingle(db, companyId, agentId, item).then((r) => r ?? undefined),
      ),
    );
    // Filter out undefined (notifications)
    const filtered = results.filter((r) => r !== undefined);
    return filtered.length > 0 ? filtered : undefined;
  }

  return dispatchSingle(db, companyId, agentId, body);
}

async function dispatchSingle(
  db: Db,
  companyId: string,
  agentId: string,
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
      case "initialize":
        return handleInitialize(id);

      case "notifications/initialized":
        // No-op notification: return undefined per JSON-RPC spec
        return undefined;

      case "tools/list":
        return successResponse(id, await handleToolsList(db, companyId, agentId));

      case "tools/call":
        return successResponse(
          id,
          await handleToolsCall(db, companyId, agentId, req.params),
        );

      default:
        return errorResponse(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
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

async function handleToolsList(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ tools: unknown[] }> {
  const servers = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.companyId, companyId));

  if (servers.length === 0) return { tools: [] };

  const grants = await db
    .select()
    .from(mcpServerGrants)
    .where(eq(mcpServerGrants.companyId, companyId));

  const merged: unknown[] = [];

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
        ...tool,
        name: `${server.name}__${tool.name}`,
        description: tool.description
          ? `[${server.name}] ${tool.description}`
          : `[${server.name}]`,
      });
    }
  }

  return { tools: merged };
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

  // Create pending invocation row
  const invId = randomUUID();
  const requestHash = hashPayload(toolArgs);
  await db.insert(mcpInvocations).values({
    id: invId,
    companyId,
    agentId,
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
    const result = await pooled.client.callTool({ name: toolName, arguments: toolArgs });
    const responseHash = hashPayload(result);

    await db
      .update(mcpInvocations)
      .set({ status: "succeeded", responsePayloadHash: responseHash, finishedAt: new Date() })
      .where(eq(mcpInvocations.id, invId));

    // Reset consecutive failures on success
    pooled.consecutiveFails = 0;

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
// Helpers
// ---------------------------------------------------------------------------

function resolveServerAllowlist(allowlist: Record<string, unknown> | null | undefined): string[] | null {
  if (!allowlist) return null;
  // Allowlist stored as { tools: string[] } in the JSONB column
  const tools = (allowlist as Record<string, unknown>).tools;
  if (Array.isArray(tools)) return tools as string[];
  return null;
}
