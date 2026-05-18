/**
 * Tests for the MCP gateway SSE (GET) endpoint and session management.
 *
 * Auth / shape tests use supertest (they complete synchronously).
 * SSE streaming tests spin up a real HTTP server on an ephemeral port and use
 * Node's `http.request` to collect chunks, because supertest closes the
 * response before SSE data arrives.
 */
import http from "node:http";
import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mcpGatewayRoutes } from "../routes/mcp-gateway.js";
import { errorHandler } from "../middleware/error-handler.js";
import { _setClientFactoryForTesting } from "../services/mcp/client-pool.js";
import type { PooledClient } from "../services/mcp/client-pool.js";
import {
  _resetSessionsForTesting,
  createSession,
  lookupSession,
  attachStreamToSession,
  broadcastToSession,
} from "../services/mcp/sessions.js";

// ---------------------------------------------------------------------------
// Mock activity-log and secrets (same pattern as mcp-gateway.test.ts)
// ---------------------------------------------------------------------------

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("test-token"),
  }),
}));

// ---------------------------------------------------------------------------
// Minimal Drizzle-aware DB mock
// ---------------------------------------------------------------------------

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown";
  const name = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

function createMockDb() {
  const tables = new Map<string, unknown[]>();
  const inserts: Array<{ table: string; row: unknown }> = [];
  const updates: Array<{ table: string; set: unknown }> = [];

  function select() {
    let rows: unknown[] = [];
    const chain = {
      from(table: unknown) { rows = tables.get(getTableName(table)) ?? []; return chain; },
      where() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown): Promise<unknown> {
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  function insert(table: unknown) {
    const tableName = getTableName(table);
    const chain = {
      values(row: unknown) { inserts.push({ table: tableName, row }); return chain; },
      returning() { return chain; },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown): Promise<unknown> {
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  function update(table: unknown) {
    const tableName = getTableName(table);
    const chain = {
      set(vals: unknown) { updates.push({ table: tableName, set: vals }); return chain; },
      where() { return chain; },
      returning() { return chain; },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown): Promise<unknown> {
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  return {
    select, insert, update,
    _setRows: (name: string, rows: unknown[]) => tables.set(name, rows),
    _getInserts: () => inserts,
    _getUpdates: () => updates,
  };
}

type MockDb = ReturnType<typeof createMockDb>;
let mockDb: MockDb;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_1 = "00000000-0000-0000-0000-000000000011";
const COMPANY_2 = "00000000-0000-0000-0000-000000000022";
const AGENT_1 = "00000000-0000-0000-0000-000000000001";
const AGENT_2 = "00000000-0000-0000-0000-000000000002";

function agentActor(companyId = COMPANY_1, agentId = AGENT_1) {
  return { type: "agent", agentId, companyId, source: "agent_key" };
}

function boardActor() {
  return { type: "board", userId: "user-1", source: "session", companyIds: [COMPANY_1] };
}

function makePooledClient(
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [],
  callToolResult: unknown = { content: [{ type: "text", text: "ok" }] },
): PooledClient {
  return {
    client: {
      listTools: vi.fn().mockResolvedValue({ tools }),
      callTool: vi.fn().mockResolvedValue(callToolResult),
    },
    transport: { close: vi.fn() },
    serverId: "00000000-0000-0000-0000-0000000000a1",
    companyId: COMPANY_1,
    connectedAt: Date.now(),
    consecutiveFails: 0,
    toolList: { tools },
  };
}

// Suppress unused variable warning for makePooledClient when only some tests use it
void makePooledClient;

function createApp(actor: Record<string, unknown> = agentActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", mcpGatewayRoutes(mockDb as unknown as import("@paperclipai/db").Db));
  app.use(errorHandler);
  return app;
}

function rpcRequest(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

// ---------------------------------------------------------------------------
// Real-server SSE helper
//
// Starts the Express app on an ephemeral port, opens an HTTP GET to the SSE
// path, collects data chunks for `durationMs`, then destroys the socket and
// shuts down the server.
// ---------------------------------------------------------------------------

interface SseCollectResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function collectSse(
  app: express.Express,
  path: string,
  reqHeaders: Record<string, string>,
  durationMs = 150,
): Promise<SseCollectResult> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      let body = "";
      let statusCode = 0;
      let respHeaders: Record<string, string | string[]> = {};

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method: "GET",
          headers: { Accept: "text/event-stream", ...reqHeaders },
        },
        (res) => {
          statusCode = res.statusCode ?? 0;
          respHeaders = res.headers as Record<string, string | string[]>;
          res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          res.on("error", () => { /* ignore */ });
        },
      );

      req.on("error", () => { /* ignore socket errors on abort */ });
      req.end();

      setTimeout(() => {
        req.destroy();
        server.close(() => {
          resolve({ statusCode, headers: respHeaders, body });
        });
      }, durationMs);
    });

    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp gateway SSE (GET /mcp/rpc)", () => {
  beforeEach(() => {
    mockDb = createMockDb();
    vi.clearAllMocks();
    _resetSessionsForTesting();
    _setClientFactoryForTesting(null);
  });

  afterEach(() => {
    _setClientFactoryForTesting(null);
    _resetSessionsForTesting();
  });

  // -------------------------------------------------------------------------
  // 1. GET without bearer (board actor) → 401
  // -------------------------------------------------------------------------

  it("GET without bearer (board actor) returns 401", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = boardActor();
      next();
    });
    app.use("/api", mcpGatewayRoutes(mockDb as unknown as import("@paperclipai/db").Db));
    app.use(errorHandler);

    const res = await request(app)
      .get(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // 2. GET with bearer but unknown Mcp-Session-Id → 404
  // -------------------------------------------------------------------------

  it("GET with bearer but unknown Mcp-Session-Id returns 404", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .set("Accept", "text/event-stream")
      .set("Mcp-Session-Id", "00000000-0000-0000-0000-000000000bad");

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // 3. GET with session belonging to different agent → 403
  // -------------------------------------------------------------------------

  it("GET with Mcp-Session-Id belonging to different agent returns 403", async () => {
    const sid = createSession({ companyId: COMPANY_1, agentId: AGENT_2, runId: null });

    const res = await request(createApp(agentActor(COMPANY_1, AGENT_1)))
      .get(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .set("Accept", "text/event-stream")
      .set("Mcp-Session-Id", sid);

    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 4. Valid session: connection opens and first chunk is ":ok\n\n"
  // -------------------------------------------------------------------------

  it("GET with valid session: connection opens and emits :ok comment", async () => {
    const sid = createSession({ companyId: COMPANY_1, agentId: AGENT_1, runId: null });
    const app = createApp();

    const { statusCode, body } = await collectSse(
      app,
      `/api/companies/${COMPANY_1}/mcp/rpc`,
      { "Mcp-Session-Id": sid },
      100,
    );

    expect(statusCode).toBe(200);
    expect(body).toContain(":ok\n\n");
  });

  // -------------------------------------------------------------------------
  // 5. broadcastToSession while GET is open delivers SSE frame to client
  // -------------------------------------------------------------------------

  it("broadcastToSession while GET is open delivers SSE frame to client", async () => {
    const sid = createSession({ companyId: COMPANY_1, agentId: AGENT_1, runId: null });
    const app = createApp();

    // Broadcast after a short delay so the GET stream is already open
    const broadcastPayload = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 50, total: 100 },
    });

    const broadcastTimer = setTimeout(() => {
      broadcastToSession(sid, { event: "message", data: broadcastPayload });
    }, 30);

    const { statusCode, body } = await collectSse(
      app,
      `/api/companies/${COMPANY_1}/mcp/rpc`,
      { "Mcp-Session-Id": sid },
      150,
    );

    clearTimeout(broadcastTimer);

    expect(statusCode).toBe(200);
    expect(body).toContain(":ok\n\n");
    expect(body).toContain("data: ");
    expect(body).toContain("notifications/progress");
  });

  // -------------------------------------------------------------------------
  // 6. Heartbeat: advancing timers 30 s produces ":ping\n\n"
  // -------------------------------------------------------------------------

  it("heartbeat comment is sent every 30 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const sid = createSession({ companyId: COMPANY_1, agentId: AGENT_1, runId: null });
    const app = createApp();

    // Use real-time 80 ms for the stream to open, then advance fake clock 30s
    const result = await new Promise<SseCollectResult>((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        let body = "";
        let statusCode = 0;
        let respHeaders: Record<string, string | string[]> = {};

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: addr.port,
            path: `/api/companies/${COMPANY_1}/mcp/rpc`,
            method: "GET",
            headers: { Accept: "text/event-stream", "Mcp-Session-Id": sid },
          },
          (res) => {
            statusCode = res.statusCode ?? 0;
            respHeaders = res.headers as Record<string, string | string[]>;
            res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
            res.on("error", () => { /* ignore */ });
          },
        );

        req.on("error", () => { /* ignore */ });
        req.end();

        // After 50 ms real time, advance fake clock by 30 s to trigger heartbeat
        setTimeout(() => {
          vi.advanceTimersByTime(31_000);

          // Give one real tick for the write to flush
          setImmediate(() => {
            setTimeout(() => {
              req.destroy();
              server.close(() => {
                vi.useRealTimers();
                resolve({ statusCode, headers: respHeaders, body });
              });
            }, 30);
          });
        }, 50);
      });

      server.on("error", (e) => { vi.useRealTimers(); reject(e); });
    });

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain(":ping\n\n");
  }, 10_000);

  // -------------------------------------------------------------------------
  // 7. Disconnect: socket close removes stream from session, broadcast → false
  // -------------------------------------------------------------------------

  it("disconnect removes stream attachment so subsequent broadcast returns false", async () => {
    const sid = createSession({ companyId: COMPANY_1, agentId: AGENT_1, runId: null });
    const app = createApp();

    await new Promise<void>((resolve, reject) => {
      const server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };

        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: addr.port,
            path: `/api/companies/${COMPANY_1}/mcp/rpc`,
            method: "GET",
            headers: { Accept: "text/event-stream", "Mcp-Session-Id": sid },
          },
          (res) => {
            res.on("data", () => { /* consume */ });
            res.on("error", () => { /* ignore */ });
          },
        );

        req.on("error", () => { /* ignore abort errors */ });
        req.end();

        // After the stream opens, destroy the socket
        setTimeout(() => {
          req.destroy();

          // After another tick let the close event propagate
          setTimeout(() => {
            server.close(() => {
              // Broadcast should now have no live handles
              const reached = broadcastToSession(sid, { data: '{"late":true}' });
              // Should be false (no attached streams) — not an error
              expect(reached).toBe(false);
              resolve();
            });
          }, 80);
        }, 50);
      });

      server.on("error", reject);
    });
  });

  // -------------------------------------------------------------------------
  // 8. POST initialize returns Mcp-Session-Id header (valid UUID)
  //    and session is findable via lookupSession
  // -------------------------------------------------------------------------

  it("POST initialize returns Mcp-Session-Id header and session is findable", async () => {
    mockDb._setRows("mcp_servers", []);
    mockDb._setRows("mcp_server_grants", []);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-agent", version: "0.1.0" },
      }));

    expect(res.status).toBe(200);

    const sessionId = res.headers["mcp-session-id"];
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe("string");
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const session = lookupSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.companyId).toBe(COMPANY_1);
    expect(session?.agentId).toBe(AGENT_1);

    // The _sessionId sentinel must NOT leak into the JSON-RPC response body
    expect(JSON.stringify(res.body)).not.toContain("_sessionId");
  });

  // -------------------------------------------------------------------------
  // 9. GET without Mcp-Session-Id still opens stream (silent but valid)
  // -------------------------------------------------------------------------

  it("GET without Mcp-Session-Id opens stream and sends :ok comment", async () => {
    const { statusCode, body } = await collectSse(
      createApp(),
      `/api/companies/${COMPANY_1}/mcp/rpc`,
      {},
      100,
    );

    expect(statusCode).toBe(200);
    expect(body).toContain(":ok\n\n");
  });

  // -------------------------------------------------------------------------
  // 10. GET by agent accessing wrong company → 403
  // -------------------------------------------------------------------------

  it("GET by agent accessing wrong company returns 403", async () => {
    const res = await request(createApp(agentActor(COMPANY_2, AGENT_1)))
      .get(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .set("Accept", "text/event-stream");

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Sessions module unit tests (pure in-memory, no HTTP)
// ---------------------------------------------------------------------------

describe("sessions module", () => {
  beforeEach(() => {
    _resetSessionsForTesting();
  });

  it("createSession returns a valid UUID and lookupSession finds it", () => {
    const sid = createSession({ companyId: "c1", agentId: "a1", runId: null });
    expect(sid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);

    const record = lookupSession(sid);
    expect(record).not.toBeNull();
    expect(record?.companyId).toBe("c1");
    expect(record?.agentId).toBe("a1");
    expect(record?.runId).toBeNull();
  });

  it("lookupSession returns null for unknown id", () => {
    expect(lookupSession("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("broadcastToSession returns false when no streams are attached", () => {
    const sid = createSession({ companyId: "c1", agentId: "a1", runId: null });
    expect(broadcastToSession(sid, { data: '{"ok":1}' })).toBe(false);
  });

  it("attachStreamToSession + broadcastToSession delivers data to write fn", () => {
    const sid = createSession({ companyId: "c1", agentId: "a1", runId: null });
    const chunks: string[] = [];

    attachStreamToSession(
      sid,
      (chunk) => { chunks.push(chunk); return true; },
      () => { /* end */ },
    );

    broadcastToSession(sid, { event: "message", data: '{"test":1}' });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('data: {"test":1}');
    // "message" is the default SSE event type; formatSseFrame omits the event:
    // field for it (per the SSE spec, receivers treat missing event as "message").
    expect(chunks[0]).not.toContain("event: message\n");
  });

  it("detach fn removes the stream so subsequent broadcasts return false", () => {
    const sid = createSession({ companyId: "c1", agentId: "a1", runId: null });
    const writes: string[] = [];

    const detach = attachStreamToSession(
      sid,
      (c) => { writes.push(c); return true; },
      () => { /* end */ },
    );

    broadcastToSession(sid, { data: "first" });
    expect(writes).toHaveLength(1);

    detach();

    const reached = broadcastToSession(sid, { data: "second" });
    expect(reached).toBe(false);
    expect(writes).toHaveLength(1); // no second write
  });

  it("broadcastToSession formats multi-line data with one data: line each", () => {
    const sid = createSession({ companyId: "c1", agentId: "a1", runId: null });
    const chunks: string[] = [];
    attachStreamToSession(
      sid,
      (c) => { chunks.push(c); return true; },
      () => { /* end */ },
    );

    broadcastToSession(sid, { data: "line1\nline2" });

    expect(chunks[0]).toContain("data: line1\n");
    expect(chunks[0]).toContain("data: line2\n");
  });

  it("createSession with runId stores it correctly", () => {
    const sid = createSession({ companyId: "c2", agentId: "a2", runId: "run-abc-123" });
    const record = lookupSession(sid);
    expect(record?.runId).toBe("run-abc-123");
  });
});
