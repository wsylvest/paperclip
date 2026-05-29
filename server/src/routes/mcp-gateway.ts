/**
 * MCP gateway route: agents connect here as if it were a single MCP server.
 *
 * POST /companies/:companyId/mcp/rpc  — JSON-RPC request/response (existing).
 * GET  /companies/:companyId/mcp/rpc  — SSE stream for server-pushed notifications.
 *
 * The GET endpoint implements the MCP Streamable HTTP transport spec's server-push
 * channel. Agents open this stream AFTER initialize so the gateway can push
 * notifications/progress (and future notification types) mid-tool-call.
 *
 * Session flow:
 *   1. Agent POST initialize → gateway responds with Mcp-Session-Id header + JSON body.
 *   2. Agent GET /mcp/rpc with Mcp-Session-Id header → opens SSE stream.
 *   3. Subsequent POSTs include Mcp-Session-Id; progress notifications from upstream
 *      are forwarded to the open SSE stream via broadcastToSession.
 *
 * Reconnection: a reconnecting agent sends the standard SSE `Last-Event-ID`
 * header on the GET request. The route flushes every buffered event newer
 * than that id from the per-session replay buffer before resuming live
 * fan-in. When the requested id has aged out of the bounded buffer, a
 * `:gap` comment is written so the agent knows it has missed events.
 * Buffer capacity is controlled by PAPERCLIP_MCP_SSE_REPLAY_BUFFER_SIZE
 * (default 1000 events per session).
 */
import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { handleGatewayRequest } from "../services/mcp/gateway.js";
import { lookupSession, attachStreamToSession, replaySinceForSession } from "../services/mcp/sessions.js";
import { unauthorized, forbidden, notFound } from "../errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HEARTBEAT_INTERVAL_MS = 30_000;

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

  // ---------------------------------------------------------------------------
  // GET /companies/:companyId/mcp/rpc — SSE server-push stream
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/mcp/rpc", async (req, res) => {
    const { companyId } = req.params as { companyId: string };

    // Auth: agent bearer only, same as POST
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

    // Validate Mcp-Session-Id if provided
    const rawSessionHeader = req.headers["mcp-session-id"];
    const sessionIdHeader = Array.isArray(rawSessionHeader)
      ? rawSessionHeader[0]
      : rawSessionHeader;

    if (sessionIdHeader) {
      const session = lookupSession(sessionIdHeader);
      if (!session) {
        throw notFound("Mcp-Session-Id not found or expired");
      }
      if (session.companyId !== companyId || session.agentId !== agentId) {
        throw forbidden("Mcp-Session-Id belongs to a different agent or company");
      }
    }
    // If no Mcp-Session-Id is present we still accept the connection, but the
    // stream will be silent until the agent sends an initialize (and then a
    // new GET with the returned session id). Document this: a session-less GET
    // is valid per spec but won't receive any server-pushed events because all
    // events in this implementation are scoped to a session.

    // SSE response headers
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      // Disable nginx / proxy buffering so chunks are flushed immediately
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Immediately write a comment to confirm the stream is open and flush.
    res.write(":ok\n\n");

    // Last-Event-ID replay: when a reconnecting agent supplies the header,
    // flush every buffered frame newer than that id before resuming live
    // fan-in. If the requested id has already been evicted from the
    // bounded buffer (eviction = events older than capacity), emit a
    // `:gap` comment so the agent knows it has missed events.
    if (sessionIdHeader) {
      const rawLastEventId = req.headers["last-event-id"];
      const lastEventIdHeader = Array.isArray(rawLastEventId)
        ? rawLastEventId[0]
        : rawLastEventId;
      if (lastEventIdHeader) {
        const parsed = Number(lastEventIdHeader);
        if (Number.isFinite(parsed) && parsed >= 0) {
          const replay = replaySinceForSession(sessionIdHeader, Math.floor(parsed));
          if (replay) {
            if (replay.gap) {
              res.write(":gap\n\n");
            }
            for (const frame of replay.frames) res.write(frame);
          }
        }
      }
    }

    // Attach to session so broadcastToSession can push into this response
    let detach: (() => void) | null = null;
    if (sessionIdHeader) {
      detach = attachStreamToSession(
        sessionIdHeader,
        (chunk) => res.write(chunk),
        () => res.end(),
      );
    }

    // Heartbeat: keep proxies alive with a comment every 30 s
    const heartbeat = setInterval(() => {
      res.write(":ping\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    function cleanup() {
      clearInterval(heartbeat);
      if (detach) {
        detach();
        detach = null;
      }
    }

    req.on("close", cleanup);
    req.on("aborted", cleanup);
  });

  // ---------------------------------------------------------------------------
  // POST /companies/:companyId/mcp/rpc — JSON-RPC request/response
  // ---------------------------------------------------------------------------

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

    // Resolve existing session id from header (optional — backward compat with
    // older agent CLIs that do not send Mcp-Session-Id).
    const rawSessionHeader = req.headers["mcp-session-id"];
    const sessionIdFromHeader = Array.isArray(rawSessionHeader)
      ? rawSessionHeader[0]
      : rawSessionHeader;
    const sessionId = sessionIdFromHeader ?? null;

    const body: unknown = req.body;

    // Basic shape validation: must be object or array
    if (
      body === null ||
      (typeof body !== "object" && !Array.isArray(body))
    ) {
      res.status(400).json({ error: "Request body must be a JSON-RPC object or array" });
      return;
    }

    const gatewayResponse = await handleGatewayRequest({
      db,
      companyId,
      agentId,
      runId,
      sessionId,
      body,
    });

    // JSON-RPC notifications have no id → return 204
    if (gatewayResponse === null) {
      res.status(204).send();
      return;
    }

    // When the gateway minted a new session (initialize), emit the header
    // BEFORE res.json() — Express requires headers before the body.
    if (gatewayResponse.sessionId) {
      res.set("Mcp-Session-Id", gatewayResponse.sessionId);
    }

    res.json(gatewayResponse.result);
  });

  return router;
}
