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
import type { Db } from "@paperclipai/db";
import { handleGatewayRequest } from "../services/mcp/gateway.js";
import { unauthorized, forbidden } from "../errors.js";

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

    const body: unknown = req.body;

    // Basic shape validation: must be object or array
    if (
      body === null ||
      (typeof body !== "object" && !Array.isArray(body))
    ) {
      res.status(400).json({ error: "Request body must be a JSON-RPC object or array" });
      return;
    }

    const result = await handleGatewayRequest({ db, companyId, agentId, body });

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
