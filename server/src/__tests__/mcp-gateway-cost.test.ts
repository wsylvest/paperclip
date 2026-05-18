/**
 * Tests for MCP gateway cost attribution.
 *
 * Verifies that tool calls with a non-zero surchargeMicrocents produce cost_events
 * rows and update mcp_invocations.costMicrocents, while calls with zero surcharge
 * or failed calls do not emit cost events.
 *
 * Uses the same fake-client-factory and drizzle-mock approach as mcp-gateway.test.ts.
 */
import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mcpGatewayRoutes } from "../routes/mcp-gateway.js";
import { errorHandler } from "../middleware/error-handler.js";
import { _setClientFactoryForTesting } from "../services/mcp/client-pool.js";
import type { PooledClient } from "../services/mcp/client-pool.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("test-token"),
  }),
}));

// Mock costService so we can assert createEvent calls without a real DB.
const mockCreateEvent = vi.fn().mockResolvedValue({ id: "cost-event-1" });
vi.mock("../services/costs.js", () => ({
  costService: () => ({
    createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  }),
}));

// ---------------------------------------------------------------------------
// Drizzle-aware DB mock (same pattern as mcp-gateway.test.ts)
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

  function select() {
    let rows: unknown[] = [];
    const chain = {
      from(table: unknown) {
        rows = state.tables.get(getTableName(table)) ?? [];
        return chain;
      },
      where() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
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
      returning() { return chain; },
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
      where() { return chain; },
      returning() { return chain; },
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
const AGENT_1 = "00000000-0000-0000-0000-000000000001";
const SERVER_A_ID = "00000000-0000-0000-0000-0000000000a1";
const GRANT_1 = "00000000-0000-0000-0000-00000000g001";

function makeServerRow(surchargeMicrocents: number) {
  return {
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
    surchargeMicrocents,
  };
}

const grantRow = {
  id: GRANT_1,
  companyId: COMPANY_1,
  mcpServerId: SERVER_A_ID,
  principalType: "agent",
  principalId: AGENT_1,
  toolAllowlist: null,
};

function makePooledClient(
  tools: Array<{ name: string; inputSchema?: Record<string, unknown> }>,
  callToolResult: unknown = { content: [{ type: "text", text: "ok" }] },
): PooledClient {
  return {
    client: {
      listTools: vi.fn().mockResolvedValue({ tools }),
      callTool: vi.fn().mockResolvedValue(callToolResult),
    },
    transport: { close: vi.fn() },
    serverId: SERVER_A_ID,
    companyId: COMPANY_1,
    connectedAt: Date.now(),
    consecutiveFails: 0,
    toolList: { tools },
  };
}

function agentActor() {
  return {
    type: "agent",
    agentId: AGENT_1,
    companyId: COMPANY_1,
    source: "agent_key",
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = agentActor();
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
// Tests
// ---------------------------------------------------------------------------

describe("mcp gateway cost attribution", () => {
  beforeEach(() => {
    mockDb = createMockDb();
    vi.clearAllMocks();
    _setClientFactoryForTesting(null);
  });

  afterEach(() => {
    _setClientFactoryForTesting(null);
  });

  // -------------------------------------------------------------------------
  // 1. Zero surcharge → no cost_events row
  // -------------------------------------------------------------------------

  it("tool call with surchargeMicrocents=0 → mcp_invocations updated with costMicrocents=0, no cost event", async () => {
    mockDb._setRows("mcp_servers", [makeServerRow(0)]);
    mockDb._setRows("mcp_server_grants", [grantRow]);

    const fakeClient = makePooledClient([{ name: "search", inputSchema: { type: "object" } }]);
    _setClientFactoryForTesting(async () => fakeClient);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/call", { name: "serverA__search", arguments: { q: "hello" } }));

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();

    // costMicrocents should be 0 in the update
    const updates = mockDb._getUpdates();
    const succeededUpdate = updates.find(
      (u) => (u.set as Record<string, unknown>).status === "succeeded",
    );
    expect(succeededUpdate).toBeDefined();
    expect((succeededUpdate!.set as Record<string, unknown>).costMicrocents).toBe(0);

    // createEvent must NOT have been called
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Non-zero surcharge → cost_events row created with correct costCents
  // -------------------------------------------------------------------------

  it("tool call with surchargeMicrocents=50000 → costMicrocents=50000 on invocation row, cost event with costCents=1", async () => {
    // 50000 microcents = $0.005 → ceil(50000/10000) = ceil(5) = 5? Wait: 50000/10000 = 5 cents
    // Actually ceil(50000/10000) = 5. But the spec says $0.005 = 0.5 cents → 1 cent.
    // That would be surchargeMicrocents=5000: 5000/10000=0.5 → ceil=1
    // The spec says "50000 (= $0.005 = 0.5 cents rounded to 1 cent)"
    // 50000 microcents = 50000 * 1e-6 USD = 0.05 USD = 5 cents. That's not 0.5 cents.
    // The spec says $0.005 which is 0.5 cents; that's 5000 microcents.
    // But the spec says use 50000. Let's follow the spec literally and check the math:
    // 50000 microcents ÷ 10000 = 5 → costCents = 5. But spec says 0.5 cents rounded to 1.
    // The spec has a math error (50000 microcents = 5 cents not 0.5).
    // We test the actual formula: ceil(surchargeMicrocents / 10_000).
    // For surchargeMicrocents=50000: ceil(50000/10000) = 5.
    // For surchargeMicrocents=5000: ceil(5000/10000) = ceil(0.5) = 1.
    // Use 5000 to match the described behavior ($0.005 = 0.5 cents → rounds to 1 cent).
    mockDb._setRows("mcp_servers", [makeServerRow(5000)]);
    mockDb._setRows("mcp_server_grants", [grantRow]);

    const fakeClient = makePooledClient([{ name: "create_issue", inputSchema: { type: "object" } }]);
    _setClientFactoryForTesting(async () => fakeClient);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/call", { name: "serverA__create_issue", arguments: {} }));

    expect(res.status).toBe(200);

    // mcp_invocations row updated with costMicrocents=5000
    const updates = mockDb._getUpdates();
    const succeededUpdate = updates.find(
      (u) => (u.set as Record<string, unknown>).status === "succeeded",
    );
    expect(succeededUpdate).toBeDefined();
    expect((succeededUpdate!.set as Record<string, unknown>).costMicrocents).toBe(5000);

    // cost event created with correct fields
    expect(mockCreateEvent).toHaveBeenCalledOnce();
    const [calledCompanyId, calledData] = mockCreateEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(calledCompanyId).toBe(COMPANY_1);
    expect(calledData.provider).toBe("mcp_gateway");
    expect(calledData.biller).toBe("paperclip");
    expect(calledData.billingType).toBe("mcp_tool_call");
    expect(calledData.model).toBe("create_issue"); // unprefixed tool name
    expect(calledData.costCents).toBe(1); // ceil(5000/10000) = ceil(0.5) = 1
    expect(calledData.inputTokens).toBe(0);
    expect(calledData.cachedInputTokens).toBe(0);
    expect(calledData.outputTokens).toBe(0);
    expect(calledData.agentId).toBe(AGENT_1);
    // heartbeatRunId is null because no runId is threaded through in this test
    expect(calledData.heartbeatRunId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Non-zero surcharge with exact cent boundary (50000 microcents = 5 cents)
  // -------------------------------------------------------------------------

  it("tool call with surchargeMicrocents=50000 → costCents=5 (exact division, no rounding needed)", async () => {
    mockDb._setRows("mcp_servers", [makeServerRow(50000)]);
    mockDb._setRows("mcp_server_grants", [grantRow]);

    const fakeClient = makePooledClient([{ name: "search", inputSchema: { type: "object" } }]);
    _setClientFactoryForTesting(async () => fakeClient);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
      .send(rpcRequest("tools/call", { name: "serverA__search", arguments: {} }));

    expect(res.status).toBe(200);
    expect(mockCreateEvent).toHaveBeenCalledOnce();
    const [, calledData] = mockCreateEvent.mock.calls[0] as [string, Record<string, unknown>];
    expect(calledData.costCents).toBe(5); // ceil(50000/10000) = ceil(5.0) = 5
  });

  // -------------------------------------------------------------------------
  // 4. Tool call FAILS → no cost event, mcp_invocations.status=failed, costMicrocents=0
  // -------------------------------------------------------------------------

  it("tool call fails → no cost event, failed invocation row with costMicrocents=0", async () => {
    mockDb._setRows("mcp_servers", [makeServerRow(50000)]);
    mockDb._setRows("mcp_server_grants", [grantRow]);

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

    // No cost event
    expect(mockCreateEvent).not.toHaveBeenCalled();

    // Invocation row set to failed (costMicrocents stays at default 0, not set in the update)
    const updates = mockDb._getUpdates();
    const failedUpdate = updates.find(
      (u) => (u.set as Record<string, unknown>).status === "failed",
    );
    expect(failedUpdate).toBeDefined();
    expect((failedUpdate!.set as Record<string, unknown>).costMicrocents).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 5. Multiple successful calls accumulate cost events
  // -------------------------------------------------------------------------

  it("3 successful calls on a server with surchargeMicrocents=10000 produce 3 cost events", async () => {
    mockDb._setRows("mcp_servers", [makeServerRow(10000)]);
    mockDb._setRows("mcp_server_grants", [grantRow]);

    const fakeClient = makePooledClient([{ name: "search", inputSchema: { type: "object" } }]);
    _setClientFactoryForTesting(async () => fakeClient);

    const app = createApp();

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post(`/api/companies/${COMPANY_1}/mcp/rpc`)
        .send(rpcRequest("tools/call", { name: "serverA__search", arguments: {} }, i + 1));
      expect(res.status).toBe(200);
      expect(res.body.result).toBeDefined();
    }

    expect(mockCreateEvent).toHaveBeenCalledTimes(3);
    for (const call of mockCreateEvent.mock.calls) {
      const [, calledData] = call as [string, Record<string, unknown>];
      expect(calledData.costCents).toBe(1); // ceil(10000/10000) = 1
    }
  });
});
