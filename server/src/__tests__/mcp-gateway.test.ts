/**
 * Tests for the MCP gateway route and gateway service.
 *
 * The MCP client pool is replaced with a test factory via
 * `_setClientFactoryForTesting` so no real upstream MCP server is needed.
 *
 * The gateway service (`handleGatewayRequest`) is tested through the full
 * Express route stack using a carefully crafted DB mock that routes queries
 * by drizzle table name (resolved via the `Symbol(drizzle:Name)` symbol).
 */
import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mcpGatewayRoutes } from "../routes/mcp-gateway.js";
import { errorHandler } from "../middleware/error-handler.js";
import { _setClientFactoryForTesting } from "../services/mcp/client-pool.js";
import type { PooledClient } from "../services/mcp/client-pool.js";

// ---------------------------------------------------------------------------
// Mock the activity log so it doesn't need a real DB
// ---------------------------------------------------------------------------

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

// Mock secrets service
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("test-token"),
  }),
}));

// ---------------------------------------------------------------------------
// Drizzle-aware DB mock
// ---------------------------------------------------------------------------

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown";
  const name = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

interface MockDbState {
  tables: Map<string, unknown[]>;
  inserts: Array<{ table: string; row: unknown }>;
  updates: Array<{ table: string; set: unknown }>;
}

function createMockDb() {
  const state: MockDbState = {
    tables: new Map(),
    inserts: [],
    updates: [],
  };

  function reset() {
    state.tables.clear();
    state.inserts = [];
    state.updates = [];
  }

  function setRows(tableName: string, rows: unknown[]) {
    state.tables.set(tableName, rows);
  }

  function getInserts() {
    return state.inserts;
  }

  function getUpdates() {
    return state.updates;
  }

  // Build a chainable select query mock
  function select() {
    let resolvedTableName = "unknown";
    let rows: unknown[] = [];

    const chain = {
      from(table: unknown) {
        resolvedTableName = getTableName(table);
        rows = state.tables.get(resolvedTableName) ?? [];
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return chain;
      },
      then(
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ): Promise<unknown> {
        return Promise.resolve(rows).then(onFulfilled, onRejected);
      },
    };

    return chain;
  }

  function insert(table: unknown) {
    const tableName = getTableName(table);

    const chain = {
      values(row: unknown) {
        state.inserts.push({ table: tableName, row });
        return chain;
      },
      returning() {
        return chain;
      },
      then(
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ): Promise<unknown> {
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    };

    return chain;
  }

  function update(table: unknown) {
    const tableName = getTableName(table);

    const chain = {
      set(vals: unknown) {
        state.updates.push({ table: tableName, set: vals });
        return chain;
      },
      where() {
        return chain;
      },
      returning() {
        return chain;
      },
      then(
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ): Promise<unknown> {
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    };

    return chain;
  }

  return {
    select,
    insert,
    update,
    // Test helpers
    _reset: reset,
    _setRows: setRows,
    _getInserts: getInserts,
    _getUpdates: getUpdates,
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
const SERVER_A_ID = "00000000-0000-0000-0000-0000000000a1";
const SERVER_B_ID = "00000000-0000-0000-0000-0000000000b2";
const GRANT_1 = "00000000-0000-0000-0000-00000000g001";
const GRANT_2 = "00000000-0000-0000-0000-00000000g002";

const serverARow = {
  id: SERVER_A_ID,
  companyId: COMPANY_1,
  name: "serverA",
  transport: "streamable_http",
  endpoint: "http://upstream-a.local/mcp",
  authType: "none",
  authSecretRef: null,
  allowlist: null,
  healthStatus: "healthy",
  consecutiveFails: 0,
};

const serverBRow = {
  id: SERVER_B_ID,
  companyId: COMPANY_1,
  name: "serverB",
  transport: "streamable_http",
  endpoint: "http://upstream-b.local/mcp",
  authType: "none",
  authSecretRef: null,
  allowlist: null,
  healthStatus: "healthy",
  consecutiveFails: 0,
};

const grantAgentARow = {
  id: GRANT_1,
  companyId: COMPANY_1,
  mcpServerId: SERVER_A_ID,
  principalType: "agent",
  principalId: AGENT_1,
  toolAllowlist: null,
};

const grantAgentBRow = {
  id: GRANT_2,
  companyId: COMPANY_1,
  mcpServerId: SERVER_B_ID,
  principalType: "agent",
  principalId: AGENT_1,
  toolAllowlist: null,
};

function makePooledClient(
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
  callToolResult: unknown = { content: [{ type: "text", text: "ok" }] },
  serverId: string = SERVER_A_ID,
): PooledClient {
  return {
    client: {
      listTools: vi.fn().mockResolvedValue({ tools }),
      callTool: vi.fn().mockResolvedValue(callToolResult),
    },
    transport: { close: vi.fn() },
    serverId,
    companyId: COMPANY_1,
    connectedAt: Date.now(),
    consecutiveFails: 0,
    toolList: { tools },
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function agentActor(companyId = COMPANY_1, agentId = AGENT_1) {
  return {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
  };
}

function boardActor(companyId = COMPANY_1) {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "admin" }],
  };
}

function createApp(actor: Record<string, unknown> = agentActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  // Pass the mockDb cast as Db — the gateway only calls select/insert/update
  app.use("/api", mcpGatewayRoutes(mockDb as unknown as import("@paperclipai/db").Db));
  app.use(errorHandler);
  return app;
}

function rpcRequest(method: string, params?: unknown, id: unknown = 1) {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp gateway routes", () => {
  beforeEach(() => {
    mockDb = createMockDb();
    vi.clearAllMocks();
    _setClientFactoryForTesting(null);
  });

  afterEach(() => {
    _setClientFactoryForTesting(null);
  });

  // -------------------------------------------------------------------------
  // 1. Auth
  // -------------------------------------------------------------------------

  it("returns 401 when actor is a board user", async () => {
    const res = await request(createApp(boardActor()))
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("initialize"));

    expect(res.status).toBe(401);
  });

  it("returns 403 when agent accesses wrong company", async () => {
    const res = await request(createApp(agentActor(COMPANY_2, AGENT_1)))
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("initialize"));

    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // 2. initialize
  // -------------------------------------------------------------------------

  it("initialize: returns valid protocolVersion even with no grants", async () => {
    mockDb._setRows("mcp_servers", []);
    mockDb._setRows("mcp_server_grants", []);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.1" },
      }));

    expect(res.status).toBe(200);
    expect(res.body.result.protocolVersion).toBe("2025-06-18");
    expect(res.body.result.serverInfo.name).toBe("paperclip-mcp-gateway");
    expect(res.body.result.capabilities.tools).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 3. tools/list — empty
  // -------------------------------------------------------------------------

  it("tools/list: agent with no granted servers gets empty tool list", async () => {
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", []); // no grants

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/list", {}));

    expect(res.status).toBe(200);
    expect(res.body.result.tools).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. tools/list — merged from two servers
  // -------------------------------------------------------------------------

  it("tools/list: two granted servers each with 2 tools → 4 prefixed entries", async () => {
    mockDb._setRows("mcp_servers", [serverARow, serverBRow]);
    mockDb._setRows("mcp_server_grants", [grantAgentARow, grantAgentBRow]);

    const toolsA = [
      { name: "t1", description: "Tool 1", inputSchema: { type: "object", properties: {} } },
      { name: "t2", description: "Tool 2", inputSchema: { type: "object", properties: {} } },
    ];
    const toolsB = [
      { name: "t3", description: "Tool 3", inputSchema: { type: "object", properties: {} } },
      { name: "t4", description: "Tool 4", inputSchema: { type: "object", properties: {} } },
    ];

    // The client pool acquireClient also queries mcp_servers — we need to handle
    // that by using the test factory injection (which bypasses DB queries in pool)
    _setClientFactoryForTesting(async (_db, server) => {
      const tools = server.serverId === SERVER_A_ID ? toolsA : toolsB;
      return makePooledClient(tools, undefined, server.serverId);
    });

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/list", {}));

    expect(res.status).toBe(200);
    const toolNames: string[] = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toHaveLength(4);
    expect(toolNames).toContain("serverA__t1");
    expect(toolNames).toContain("serverA__t2");
    expect(toolNames).toContain("serverB__t3");
    expect(toolNames).toContain("serverB__t4");
  });

  // -------------------------------------------------------------------------
  // 5. tools/list — grant toolAllowlist filtering
  // -------------------------------------------------------------------------

  it("tools/list: grant with toolAllowlist=['t1','t2'] only exposes those tools", async () => {
    const restrictedGrant = {
      ...grantAgentARow,
      toolAllowlist: ["t1", "t2"],
    };
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", [restrictedGrant]);

    const tools = [
      { name: "t1", inputSchema: { type: "object" } },
      { name: "t2", inputSchema: { type: "object" } },
      { name: "t3", inputSchema: { type: "object" } },
    ];
    _setClientFactoryForTesting(async () => makePooledClient(tools));

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/list", {}));

    expect(res.status).toBe(200);
    const toolNames: string[] = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toHaveLength(2);
    expect(toolNames).toContain("serverA__t1");
    expect(toolNames).toContain("serverA__t2");
    expect(toolNames).not.toContain("serverA__t3");
  });

  // -------------------------------------------------------------------------
  // 6. tools/call — happy path
  // -------------------------------------------------------------------------

  it("tools/call: happy path writes succeeded invocation row", async () => {
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", [grantAgentARow]);

    const callToolResult = { content: [{ type: "text", text: "ok" }] };
    const fakeClient = makePooledClient(
      [{ name: "search", inputSchema: { type: "object" } }],
      callToolResult,
    );
    _setClientFactoryForTesting(async () => fakeClient);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/call", { name: "serverA__search", arguments: { q: "hello" } }));

    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject(callToolResult);

    // Verify invocation row inserted
    const inserts = mockDb._getInserts();
    const invInsert = inserts.find(
      (i) => (i.row as Record<string, unknown>).toolName === "search",
    );
    expect(invInsert).toBeDefined();
    expect((invInsert!.row as Record<string, unknown>).requestPayloadHash).toBeTruthy();
    expect((invInsert!.row as Record<string, unknown>).status).toBe("pending");

    // Verify update to succeeded with responsePayloadHash
    const updates = mockDb._getUpdates();
    const succeededUpdate = updates.find(
      (u) => (u.set as Record<string, unknown>).status === "succeeded",
    );
    expect(succeededUpdate).toBeDefined();
    expect((succeededUpdate!.set as Record<string, unknown>).responsePayloadHash).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 7. tools/call — denied
  // -------------------------------------------------------------------------

  it("tools/call: tool not in grant returns JSON-RPC error -32000 and writes denied row", async () => {
    const restrictedGrant = {
      ...grantAgentARow,
      toolAllowlist: ["allowed_tool"],
    };
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", [restrictedGrant]);

    _setClientFactoryForTesting(async () =>
      makePooledClient([{ name: "secret_tool", inputSchema: { type: "object" } }]),
    );

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/call", { name: "serverA__secret_tool", arguments: {} }));

    expect(res.status).toBe(200);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32000);
    expect(res.body.error.message).toMatch(/denied/i);

    const inserts = mockDb._getInserts();
    const deniedInsert = inserts.find(
      (i) => (i.row as Record<string, unknown>).status === "denied",
    );
    expect(deniedInsert).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 8. tools/call — upstream failure
  // -------------------------------------------------------------------------

  it("tools/call: upstream client throws → JSON-RPC error and failed invocation row", async () => {
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", [grantAgentARow]);

    const fakeClient = makePooledClient([{ name: "explode", inputSchema: { type: "object" } }]);
    (fakeClient.client.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("upstream transport error"),
    );
    _setClientFactoryForTesting(async () => fakeClient);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/call", { name: "serverA__explode", arguments: {} }));

    expect(res.status).toBe(200);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32000);

    const updates = mockDb._getUpdates();
    const failedUpdate = updates.find(
      (u) => (u.set as Record<string, unknown>).status === "failed",
    );
    expect(failedUpdate).toBeDefined();
    expect((failedUpdate!.set as Record<string, unknown>).errorClass).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 9. Cross-company isolation
  // -------------------------------------------------------------------------

  it("cross-company: agent from company A cannot POST to company B endpoint → 403", async () => {
    // Route enforces req.actor.companyId === companyId in URL
    const res = await request(createApp(agentActor(COMPANY_1, AGENT_1)))
      .post(`/api/companies/${COMPANY_2}/mcp/rpc`)
      .send(rpcRequest("tools/list", {}));

    expect(res.status).toBe(403);
  });

  it("cross-company: server name collision doesn't leak — gateway scopes to companyId from actor", async () => {
    // Company 1 agent tries tools/call for serverA, but no grants exist
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", []); // no grants for AGENT_1

    const res = await request(createApp(agentActor(COMPANY_1, AGENT_1)))
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/call", { name: "serverA__search", arguments: {} }));

    expect(res.status).toBe(200);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe(-32000);
    expect(res.body.error.message).toMatch(/denied/i);
  });

  // -------------------------------------------------------------------------
  // 10. Batch requests
  // -------------------------------------------------------------------------

  it("batch: array of two tools/list requests returns array of two responses", async () => {
    mockDb._setRows("mcp_servers", []);
    mockDb._setRows("mcp_server_grants", []);

    const batch = [
      rpcRequest("tools/list", {}, 1),
      rpcRequest("tools/list", {}, 2),
    ];

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(batch);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe(1);
    expect(res.body[1].id).toBe(2);
    expect(res.body[0].result.tools).toEqual([]);
    expect(res.body[1].result.tools).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Extra: notifications return 204
  // -------------------------------------------------------------------------

  it("notifications/initialized returns 204 No Content", async () => {
    // No id = notification per JSON-RPC spec
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });

    expect(res.status).toBe(204);
  });

  // -------------------------------------------------------------------------
  // Extra: unknown method
  // -------------------------------------------------------------------------

  it("unknown method returns JSON-RPC error -32601", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/nonexistent", {}));

    expect(res.status).toBe(200);
    expect(res.body.error.code).toBe(-32601);
  });

  // -------------------------------------------------------------------------
  // X-Paperclip-Run-Id header — runId threading for cost attribution
  // -------------------------------------------------------------------------

  it("tools/call without X-Paperclip-Run-Id: heartbeatRunId is null", async () => {
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", [grantAgentARow]);
    _setClientFactoryForTesting(async () =>
      makePooledClient([{ name: "search", inputSchema: { type: "object" } }], {
        content: [{ type: "text", text: "ok" }],
      }),
    );

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/call", { name: "serverA__search", arguments: { q: "x" } }));

    expect(res.status).toBe(200);
    const invInsert = mockDb._getInserts().find(
      (i) => (i.row as Record<string, unknown>).toolName === "search",
    );
    expect((invInsert!.row as Record<string, unknown>).runId).toBeNull();
  });

  it("tools/call with valid X-Paperclip-Run-Id: invocation row carries runId", async () => {
    const RUN_ID = "11111111-2222-3333-4444-555555555555";
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", [grantAgentARow]);
    // The route validates the header against heartbeat_runs scoped to the agent.
    mockDb._setRows("heartbeat_runs", [
      { id: RUN_ID, agentId: AGENT_1, companyId: COMPANY_1 },
    ]);
    _setClientFactoryForTesting(async () =>
      makePooledClient([{ name: "search", inputSchema: { type: "object" } }], {
        content: [{ type: "text", text: "ok" }],
      }),
    );

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .set("X-Paperclip-Run-Id", RUN_ID)
      .send(rpcRequest("tools/call", { name: "serverA__search", arguments: { q: "x" } }));

    expect(res.status).toBe(200);
    const invInsert = mockDb._getInserts().find(
      (i) => (i.row as Record<string, unknown>).toolName === "search",
    );
    expect((invInsert!.row as Record<string, unknown>).runId).toBe(RUN_ID);
  });

  it("tools/call with malformed X-Paperclip-Run-Id is silently dropped", async () => {
    mockDb._setRows("mcp_servers", [serverARow]);
    mockDb._setRows("mcp_server_grants", [grantAgentARow]);
    _setClientFactoryForTesting(async () =>
      makePooledClient([{ name: "search", inputSchema: { type: "object" } }], {
        content: [{ type: "text", text: "ok" }],
      }),
    );

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .set("X-Paperclip-Run-Id", "not-a-uuid")
      .send(rpcRequest("tools/call", { name: "serverA__search", arguments: { q: "x" } }));

    expect(res.status).toBe(200);
    const invInsert = mockDb._getInserts().find(
      (i) => (i.row as Record<string, unknown>).toolName === "search",
    );
    expect((invInsert!.row as Record<string, unknown>).runId).toBeNull();
  });
});
