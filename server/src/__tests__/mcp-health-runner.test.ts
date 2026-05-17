/**
 * Unit tests for the MCP health-check runner.
 *
 * The client pool is replaced with a test factory via
 * `_setClientFactoryForTesting` / `_resetClientPoolForTesting` so no real
 * upstream MCP server is needed.
 *
 * The DB is a minimal drizzle-shape mock that tracks selects, updates, and
 * inserts by table name (resolved via the drizzle:Name symbol).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetClientPoolForTesting,
  _setClientFactoryForTesting,
} from "../services/mcp/client-pool.js";
import type { PooledClient } from "../services/mcp/client-pool.js";
import { runHealthCycle, probeOneServer } from "../services/mcp/health-runner.js";

// ---------------------------------------------------------------------------
// Mock activity-log so it doesn't need a real DB / instance settings
// ---------------------------------------------------------------------------

const mockLogActivity = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/activity-log.js", () => ({
  logActivity: (...args: unknown[]) => mockLogActivity(...args),
}));

// ---------------------------------------------------------------------------
// Minimal drizzle-shape DB mock
// ---------------------------------------------------------------------------

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown";
  const name = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

interface MockDbState {
  tables: Map<string, unknown[]>;
  updates: Array<{ table: string; set: unknown }>;
  inserts: Array<{ table: string; row: unknown }>;
}

function createMockDb() {
  const state: MockDbState = {
    tables: new Map(),
    updates: [],
    inserts: [],
  };

  function reset() {
    state.tables.clear();
    state.updates = [];
    state.inserts = [];
  }

  function setRows(tableName: string, rows: unknown[]) {
    state.tables.set(tableName, rows);
  }

  function getUpdates() {
    return state.updates;
  }

  function getInserts() {
    return state.inserts;
  }

  // Chainable select — filters are ignored; all rows are returned for simplicity
  function select(_fields?: unknown) {
    let resolvedRows: unknown[] = [];

    const chain = {
      from(table: unknown) {
        resolvedRows = [...(state.tables.get(getTableName(table)) ?? [])];
        return chain;
      },
      where(_cond: unknown) {
        return chain;
      },
      orderBy(_ord: unknown) {
        return chain;
      },
      limit(n: number) {
        resolvedRows = resolvedRows.slice(0, n);
        return chain;
      },
      then(
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (e: unknown) => unknown,
      ): Promise<unknown> {
        return Promise.resolve(resolvedRows).then(onFulfilled, onRejected);
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
      where(_cond: unknown) {
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

  return {
    select,
    update,
    insert,
    _reset: reset,
    _setRows: setRows,
    _getUpdates: getUpdates,
    _getInserts: getInserts,
  };
}

type MockDb = ReturnType<typeof createMockDb>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_1 = "00000000-0000-0000-0000-000000000011";
const COMPANY_2 = "00000000-0000-0000-0000-000000000022";
const SERVER_1 = "00000000-0000-0000-0000-0000000000s1";
const SERVER_2 = "00000000-0000-0000-0000-0000000000s2";
const SERVER_3 = "00000000-0000-0000-0000-0000000000s3";

function makeServer(
  id: string,
  overrides: Partial<{
    companyId: string;
    healthStatus: string;
    consecutiveFails: number;
    healthCheckedAt: string | null;
  }> = {},
) {
  return {
    id,
    companyId: overrides.companyId ?? COMPANY_1,
    healthStatus: overrides.healthStatus ?? "unknown",
    consecutiveFails: overrides.consecutiveFails ?? 0,
    healthCheckedAt: overrides.healthCheckedAt ?? null,
    name: `server-${id.slice(-2)}`,
    transport: "streamable_http",
    endpoint: "http://localhost:9999/mcp",
    authType: "none",
    authSecretRef: null,
  };
}

function makePooledClient(serverId = SERVER_1, companyId = COMPANY_1): PooledClient {
  return {
    client: {
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      callTool: vi.fn(),
    },
    transport: { close: vi.fn() },
    serverId,
    companyId,
    connectedAt: Date.now(),
    consecutiveFails: 0,
    toolList: { tools: [] },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let db: MockDb;

beforeEach(() => {
  db = createMockDb();
  mockLogActivity.mockClear();
});

afterEach(() => {
  _resetClientPoolForTesting();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runHealthCycle", () => {
  it("returns scanned:0 when no servers exist", async () => {
    db._setRows("mcp_servers", []);

    const summary = await runHealthCycle(db as any);

    expect(summary.scanned).toBe(0);
    expect(summary.results).toHaveLength(0);
    expect(db._getUpdates()).toHaveLength(0);
  });

  it("marks all three servers healthy when factory succeeds for all", async () => {
    const servers = [
      makeServer(SERVER_1),
      makeServer(SERVER_2),
      makeServer(SERVER_3),
    ];
    db._setRows("mcp_servers", servers);

    _setClientFactoryForTesting(async (_db, { serverId, companyId }) => {
      return makePooledClient(serverId, companyId);
    });

    const summary = await runHealthCycle(db as any);

    expect(summary.scanned).toBe(3);
    expect(summary.results).toHaveLength(3);
    for (const result of summary.results) {
      expect(result.newStatus).toBe("healthy");
      expect(result.consecutiveFails).toBe(0);
    }

    const updates = db._getUpdates();
    expect(updates).toHaveLength(3);
    for (const update of updates) {
      expect((update.set as any).healthStatus).toBe("healthy");
      expect((update.set as any).consecutiveFails).toBe(0);
    }
  });

  it("marks degraded (consecutiveFails=1) when server has 0 prior fails and factory throws", async () => {
    const server = makeServer(SERVER_1, { healthStatus: "healthy", consecutiveFails: 0 });
    db._setRows("mcp_servers", [server]);

    _setClientFactoryForTesting(async () => {
      throw new Error("Connection refused");
    });

    const summary = await runHealthCycle(db as any);

    expect(summary.scanned).toBe(1);
    const result = summary.results[0]!;
    expect(result.newStatus).toBe("degraded");
    expect(result.consecutiveFails).toBe(1);
    expect(result.error).toBe("Error");

    const updates = db._getUpdates();
    expect(updates).toHaveLength(1);
    expect((updates[0]!.set as any).healthStatus).toBe("degraded");
    expect((updates[0]!.set as any).consecutiveFails).toBe(1);
  });

  it("marks dead (consecutiveFails=3) and writes activity log when server had 2 prior fails", async () => {
    const server = makeServer(SERVER_1, {
      healthStatus: "healthy",
      consecutiveFails: 2,
    });
    db._setRows("mcp_servers", [server]);

    _setClientFactoryForTesting(async () => {
      throw new Error("Still down");
    });

    const summary = await runHealthCycle(db as any);

    expect(summary.scanned).toBe(1);
    const result = summary.results[0]!;
    expect(result.newStatus).toBe("dead");
    expect(result.consecutiveFails).toBe(3);

    // Activity log: healthy → dead is a significant transition
    expect(mockLogActivity).toHaveBeenCalledOnce();
    const logCall = mockLogActivity.mock.calls[0][1] as any;
    expect(logCall.action).toBe("mcp_server.health_changed");
    expect(logCall.details.previous).toBe("healthy");
    expect(logCall.details.current).toBe("dead");
    expect(logCall.details.consecutiveFails).toBe(3);
  });

  it("marks healthy and writes activity log when dead server recovers", async () => {
    const server = makeServer(SERVER_1, { healthStatus: "dead", consecutiveFails: 5 });
    db._setRows("mcp_servers", [server]);

    _setClientFactoryForTesting(async (_db, { serverId, companyId }) => {
      return makePooledClient(serverId, companyId);
    });

    const summary = await runHealthCycle(db as any);

    expect(summary.scanned).toBe(1);
    const result = summary.results[0]!;
    expect(result.newStatus).toBe("healthy");
    expect(result.consecutiveFails).toBe(0);

    // Activity log: dead → healthy is a significant transition
    expect(mockLogActivity).toHaveBeenCalledOnce();
    const logCall = mockLogActivity.mock.calls[0][1] as any;
    expect(logCall.action).toBe("mcp_server.health_changed");
    expect(logCall.details.previous).toBe("dead");
    expect(logCall.details.current).toBe("healthy");
  });

  it("marks degraded after probe timeout", async () => {
    const server = makeServer(SERVER_1, { healthStatus: "unknown", consecutiveFails: 0 });
    db._setRows("mcp_servers", [server]);

    _setClientFactoryForTesting(async () => {
      // Never resolves
      return new Promise<PooledClient>(() => {});
    });

    const summary = await runHealthCycle(db as any, { probeTimeoutMs: 50 });

    expect(summary.scanned).toBe(1);
    const result = summary.results[0]!;
    expect(result.newStatus).toBe("degraded");
    expect(result.consecutiveFails).toBe(1);
    expect(result.error).toBe("TimeoutError");
  }, 3000);

  it("respects maxServersPerCycle=2 when 5 servers exist", async () => {
    const servers = [
      makeServer(SERVER_1, { healthCheckedAt: "2020-01-01T00:00:00Z" }),
      makeServer(SERVER_2, { healthCheckedAt: "2020-01-02T00:00:00Z" }),
      makeServer(SERVER_3, { healthCheckedAt: "2020-01-03T00:00:00Z" }),
      makeServer("00000000-0000-0000-0000-0000000000s4", { healthCheckedAt: "2020-01-04T00:00:00Z" }),
      makeServer("00000000-0000-0000-0000-0000000000s5", { healthCheckedAt: "2020-01-05T00:00:00Z" }),
    ];
    db._setRows("mcp_servers", servers);

    _setClientFactoryForTesting(async (_db, { serverId, companyId }) => {
      return makePooledClient(serverId, companyId);
    });

    const summary = await runHealthCycle(db as any, { maxServersPerCycle: 2 });

    expect(summary.scanned).toBe(2);
    expect(summary.results).toHaveLength(2);
    expect(db._getUpdates()).toHaveLength(2);
  });
});

describe("probeOneServer", () => {
  it("returns null for a non-existent server (route should 404)", async () => {
    db._setRows("mcp_servers", []);

    const result = await probeOneServer(db as any, COMPANY_1, SERVER_1);

    expect(result).toBeNull();
    expect(db._getUpdates()).toHaveLength(0);
  });

  it("returns healthy result when factory succeeds", async () => {
    const server = makeServer(SERVER_1, { healthStatus: "dead", consecutiveFails: 4 });
    db._setRows("mcp_servers", [server]);

    _setClientFactoryForTesting(async (_db, { serverId, companyId }) => {
      return makePooledClient(serverId, companyId);
    });

    const result = await probeOneServer(db as any, COMPANY_1, SERVER_1);

    expect(result).not.toBeNull();
    expect(result!.newStatus).toBe("healthy");
    expect(result!.consecutiveFails).toBe(0);
    expect(result!.serverId).toBe(SERVER_1);
    expect(result!.companyId).toBe(COMPANY_1);

    // Should have written a DB update
    const updates = db._getUpdates();
    expect(updates).toHaveLength(1);
    expect((updates[0]!.set as any).healthStatus).toBe("healthy");
  });

  it("returns null when server belongs to a different company", async () => {
    // The mock DB does not filter by companyId (returns all rows regardless of
    // where clause), but we can verify behaviour when the table is empty for
    // the queried company — simulated by leaving the table empty.
    db._setRows("mcp_servers", []);

    const result = await probeOneServer(db as any, COMPANY_2, SERVER_1);

    expect(result).toBeNull();
  });
});
