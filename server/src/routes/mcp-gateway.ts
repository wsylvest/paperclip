/**
 * MCP gateway route: agents connect here as if it were a single MCP server.
 *
 * POST /companies/:companyId/mcp/rpc
 *
 * The route handles single JSON-RPC requests and batch arrays.
 * For notifications (no id field), the handler returns 204 No Content.
 *
 * TODO: add GET /companies/:companyId/mcp/rpc for SSE event-stream push
 *       (required for server-initiated messages per MCP Streamable HTTP spec).
 */
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { handleGatewayRequest } from "../services/mcp/gateway.js";
import { unauthorized, forbidden } from "../errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that the runId, if provided, belongs to the bearer-authenticated
 * agent in this company. Returns the runId if valid, null otherwise.
 *
 * Invalid runIds are silently dropped (treated as null) rather than throwing
 * 403 — agent CLIs shouldn't have to handle "your run id is stale" gracefully
 * mid-tool-call. Cost attribution will fall back to heartbeatRunId=null for
 * the affected call.
 */
async function resolveRunIdHeader(
  db: Db,
  rawHeader: string | string[] | undefined,
  agentId: string,
  companyId: string,
): Promise<string | null> {
  const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!value || typeof value !== "string" || !UUID_RE.test(value)) {
    return null;
  }
  const row = await db
    .select({ agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, value))
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  if (row.agentId !== agentId || row.companyId !== companyId) return null;
  return value;
}

export function mcpGatewayRoutes(db: Db): Router {
  const router = Router();

  router.post("/companies/:companyId/mcp/rpc", async (req, res) => {
    const { companyId } = req.params as { companyId: string };

    // Auth checks
    if (req.actor.type !== "agent") {
      throw unauthorized();
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const agentId = req.actor.agentId;
    if (!agentId) {
      throw forbidden("Agent identity could not be resolved");
    }

    const runId = await resolveRunIdHeader(
      db,
      req.headers["x-paperclip-run-id"],
      agentId,
      companyId,
    );

    const body: unknown = req.body;

    // Basic shape validation: must be object or array
    if (
      body === null ||
      (typeof body !== "object" && !Array.isArray(body))
    ) {
      res.status(400).json({ error: "Request body must be a JSON-RPC object or array" });
      return;
    }

    const result = await handleGatewayRequest({ db, companyId, agentId, runId, body });

    // JSON-RPC notifications have no id → return 204
    if (result === undefined || result === null) {
      res.status(204).send();
      return;
    }

    // Batch: filter out undefined slots (notifications in a batch)
    if (Array.isArray(result) && result.length === 0) {
      res.status(204).send();
      return;
    }

    res.json(result);
  });

  return router;
}
