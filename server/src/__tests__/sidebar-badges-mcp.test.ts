/**
 * Tests for the mcpDegraded field added to sidebar badges.
 *
 * Uses the sidebarBadgeService directly against a mock DB so no live Postgres
 * is needed. The mock DB returns pre-seeded row sets for each table queried
 * by the service, with a configurable "count override" so the count() query
 * can return a filtered result without needing to introspect drizzle conditions.
 */
import { describe, expect, it } from "vitest";
import { sidebarBadgeService } from "../services/sidebar-badges.js";

// ---------------------------------------------------------------------------
// Minimal drizzle-shape DB mock
// ---------------------------------------------------------------------------

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown";
  const name = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

/**
 * Creates a mock DB that:
 * - returns `tableData[tableName]` rows for regular selects
 * - returns `countOverrides[tableName]` as the count() result when present,
 *   falling back to the full row count
 */
function createMockDb(
  tableData: Record<string, unknown[]> = {},
  countOverrides: Record<string, number> = {},
) {
  function select(fields?: unknown) {
    let resolvedRows: unknown[] = [];
    let tableName = "unknown";

    // Detect count() select by checking for a single field with queryChunks
    const isCountSelect =
      fields !== null &&
      fields !== undefined &&
      typeof fields === "object" &&
      !Array.isArray(fields) &&
      (() => {
        const vals = Object.values(fields as Record<string, unknown>);
        return (
          vals.length === 1 &&
          vals[0] !== null &&
          typeof vals[0] === "object" &&
          "queryChunks" in (vals[0] as object)
        );
      })();

    const chain = {
      from(table: unknown) {
        tableName = getTableName(table);
        resolvedRows = [...(tableData[tableName] ?? [])];
        return chain;
      },
      innerJoin(_table: unknown, _cond: unknown) {
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
        let result: unknown;
        if (isCountSelect) {
          const overrideCount = countOverrides[tableName];
          const total = overrideCount !== undefined ? overrideCount : resolvedRows.length;
          result = [{ total }];
        } else {
          result = resolvedRows;
        }
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  // selectDistinctOn delegates to select
  function selectDistinctOn(_cols: unknown, fields?: unknown) {
    return select(fields);
  }

  return { select, selectDistinctOn };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_1 = "00000000-0000-0000-0000-000000000001";

function makeMcpServer(id: string, healthStatus: string) {
  return {
    id,
    companyId: COMPANY_1,
    name: `server-${id.slice(-2)}`,
    healthStatus,
    consecutiveFails: 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sidebarBadgeService — mcpDegraded field", () => {
  it("includes mcpDegraded:0 when no MCP servers exist", async () => {
    const db = createMockDb(
      { approvals: [], heartbeat_runs: [], agents: [], mcp_servers: [] },
      { mcp_servers: 0 },
    );

    const svc = sidebarBadgeService(db as any);
    const badges = await svc.get(COMPANY_1);

    expect(badges).toHaveProperty("mcpDegraded", 0);
  });

  it("counts degraded and dead servers (not healthy or unknown)", async () => {
    const db = createMockDb(
      {
        approvals: [],
        heartbeat_runs: [],
        agents: [],
        mcp_servers: [
          makeMcpServer("00000000-0000-0000-0000-00000000aa01", "degraded"),
          makeMcpServer("00000000-0000-0000-0000-00000000aa02", "degraded"),
          makeMcpServer("00000000-0000-0000-0000-00000000aa03", "dead"),
          makeMcpServer("00000000-0000-0000-0000-00000000aa04", "healthy"),
          makeMcpServer("00000000-0000-0000-0000-00000000aa05", "unknown"),
        ],
      },
      // The count() query filters to degraded/dead — 3 of the 5 rows
      { mcp_servers: 3 },
    );

    const svc = sidebarBadgeService(db as any);
    const badges = await svc.get(COMPANY_1);

    expect(badges.mcpDegraded).toBe(3);
  });

  it("returns mcpDegraded:0 when all servers are healthy or unknown", async () => {
    const db = createMockDb(
      {
        approvals: [],
        heartbeat_runs: [],
        agents: [],
        mcp_servers: [
          makeMcpServer("00000000-0000-0000-0000-00000000bb01", "healthy"),
          makeMcpServer("00000000-0000-0000-0000-00000000bb02", "unknown"),
        ],
      },
      { mcp_servers: 0 },
    );

    const svc = sidebarBadgeService(db as any);
    const badges = await svc.get(COMPANY_1);

    expect(badges.mcpDegraded).toBe(0);
  });
});
