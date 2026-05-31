/**
 * skill-analysis-mcp-tools.test.ts
 *
 * Tests for the MCP tool population in skill-analysis and the
 * listMcpToolsForAgent helper extracted from the gateway.
 *
 * Tests:
 *  1. listMcpToolsForAgent returns merged catalog when grants exist.
 *  2. listMcpToolsForAgent returns empty array when no servers exist.
 *  3. skillAnalysisService gracefully degrades to availableMcpTools=[] when
 *     listMcpToolsForAgent throws.
 *  4. skillAnalysisService passes namespaced tool names in availableMcpTools
 *     to the dispatcher.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { listMcpToolsForAgent } from "../services/mcp/gateway.js";
import { skillAnalysisService } from "../services/skill-analysis.js";
import { _setClientFactoryForTesting } from "../services/mcp/client-pool.js";
import type { PooledClient } from "../services/mcp/client-pool.js";

// ---------------------------------------------------------------------------
// Silence activity-log and other side-effects
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
// Symbol helper (same pattern as mcp-gateway.test.ts)
// ---------------------------------------------------------------------------

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown";
  const name = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

// ---------------------------------------------------------------------------
// Minimal mock DB for listMcpToolsForAgent tests
// ---------------------------------------------------------------------------

function createGatewayMockDb(opts: {
  servers?: unknown[];
  grants?: unknown[];
}) {
  const { servers = [], grants = [] } = opts;

  return {
    select: vi.fn(() => {
      let resolvedTable = "unknown";
      const chain = {
        from(table: unknown) {
          resolvedTable = getTableName(table);
          return chain;
        },
        where() {
          if (resolvedTable === "mcp_servers") return Promise.resolve(servers);
          if (resolvedTable === "mcp_server_grants") return Promise.resolve(grants);
          return Promise.resolve([]);
        },
      };
      return chain;
    }),
  };
}

function makePooledClient(
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
  serverId: string,
): PooledClient {
  const toolsWithSchema = tools.map((t) => ({ inputSchema: {}, ...t }));
  return {
    client: {
      listTools: vi.fn().mockResolvedValue({ tools: toolsWithSchema }),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    },
    transport: null,
    toolList: { tools: toolsWithSchema },
    serverId,
    companyId: COMPANY_1,
    connectedAt: Date.now(),
    consecutiveFails: 0,
  };
}

// ---------------------------------------------------------------------------
// Mock DB for skill-analysis service (extends the call-counter pattern from
// skill-analysis-service.test.ts to accommodate the extra MCP queries)
// ---------------------------------------------------------------------------

function buildSkillAnalysisMockDb(overrides: {
  plugins?: Array<Record<string, unknown>>;
  skills?: Array<{ name: string }>;
  servers?: unknown[];
  grants?: unknown[];
} = {}) {
  const pluginRows = overrides.plugins ?? [];
  const skillRows = overrides.skills ?? [{ name: "typescript" }];
  const servers = overrides.servers ?? [];
  const grants = overrides.grants ?? [];

  // Agent ID must match grantAgentRow.principalId so canPrincipalCallTool permits
  // the tools. Use AGENT_1 ("00000000-0000-0000-0000-000000000001").
  const run = {
    id: "run-sa-mcp-1",
    companyId: COMPANY_1,
    agentId: AGENT_1,
    contextSnapshot: { issueTitle: "Refactor auth", issueBody: "Clean up the auth module." },
  };

  let selectCallCount = 0;
  const mockInsert = vi.fn().mockResolvedValue([]);

  // The analyze() method makes 3 select calls before reaching listMcpToolsForAgent:
  //   Call 1: heartbeatRuns   (.from(heartbeatRuns).where(...))
  //   Call 2: plugins join    (.from(plugins).innerJoin(...).where(...).orderBy(...))
  //   Call 3: companySkills   (.from(companySkills).where(...))
  // listMcpToolsForAgent then makes:
  //   Call 4: mcp_servers     (.from(mcpServers).where(...))
  //   Call 5: mcp_server_grants (.from(mcpServerGrants).where(...))
  // Then skill.selected insert happens (not a select call).
  const mockDb = {
    select: vi.fn(() => {
      selectCallCount++;
      const callNum = selectCallCount;

      return {
        from: vi.fn((table: unknown) => {
          const tableName = getTableName(table);
          return {
            where: vi.fn(() => {
              // Call 1: heartbeatRuns lookup
              if (callNum === 1) return Promise.resolve([run]);
              // Call 3: companySkills
              if (callNum === 3) return Promise.resolve(skillRows);
              // MCP catalog queries (calls 4+): route by table name
              if (tableName === "mcp_servers") return Promise.resolve(servers);
              if (tableName === "mcp_server_grants") return Promise.resolve(grants);
              return Promise.resolve([]);
            }),
            innerJoin: vi.fn(() => ({
              where: vi.fn(() => ({
                orderBy: vi.fn(() => Promise.resolve(pluginRows)),
              })),
            })),
            orderBy: vi.fn(() => Promise.resolve([])),
          };
        }),
      };
    }),
    insert: vi.fn(() => ({
      values: mockInsert,
    })),
  };

  return { db: mockDb as unknown as Parameters<typeof skillAnalysisService>[0], mockInsert };
}

function analyzerPluginRow(pluginKey = "paperclipai.skill-analyzer-keyword-example") {
  return {
    pluginId: "plugin-uuid-mcp-1",
    pluginKey,
    manifestJson: {
      id: pluginKey,
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Test Analyzer",
      capabilities: ["agent.tools.register"],
      capabilityTags: ["skill-analyzer"],
    },
    enabled: true,
  };
}

function buildMockDispatcher(capturedArgs: { request?: unknown } = {}) {
  return {
    executeTool: vi.fn(async (_name: string, params: unknown) => {
      capturedArgs.request = params;
      return {
        pluginId: "plugin-1",
        toolName: "analyzeTask",
        result: {
          content: JSON.stringify({
            selectedSkills: ["typescript"],
            selectedMcpTools: [],
            rationale: "test",
          }),
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Constants for gateway tests
// ---------------------------------------------------------------------------

const COMPANY_1 = "00000000-0000-0000-0000-111111111111";
const AGENT_1 = "00000000-0000-0000-0000-000000000001";
const SERVER_A_ID = "00000000-0000-0000-0000-aaaaaaaaaaaa";

const serverARow = {
  id: SERVER_A_ID,
  companyId: COMPANY_1,
  name: "github",
  transport: "streamable_http",
  endpoint: "http://upstream.local/mcp",
  authType: "none",
  authSecretRef: null,
  allowlist: null,
  healthStatus: "healthy",
  consecutiveFails: 0,
};

const grantAgentRow = {
  id: "grant-1",
  companyId: COMPANY_1,
  mcpServerId: SERVER_A_ID,
  principalType: "agent",
  principalId: AGENT_1,
  toolAllowlist: null,
};

// ---------------------------------------------------------------------------
// Tests: listMcpToolsForAgent
// ---------------------------------------------------------------------------

describe("listMcpToolsForAgent", () => {
  let originalFactory: unknown;

  beforeEach(() => {
    originalFactory = undefined;
  });

  afterEach(() => {
    // Reset to default (no factory override)
    _setClientFactoryForTesting(null);
  });

  it("returns merged catalog with prefixed names when agent has grants", async () => {
    const pooled = makePooledClient(
      [
        { name: "create_issue", description: "Create a GitHub issue" },
        { name: "list_issues", description: "List GitHub issues" },
      ],
      SERVER_A_ID,
    );

    _setClientFactoryForTesting(async () => pooled);

    const mockDb = createGatewayMockDb({
      servers: [serverARow],
      grants: [grantAgentRow],
    });

    const result = await listMcpToolsForAgent(
      mockDb as unknown as Parameters<typeof listMcpToolsForAgent>[0],
      COMPANY_1,
      AGENT_1,
    );

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0]?.name).toBe("github__create_issue");
    expect(result.tools[1]?.name).toBe("github__list_issues");
    // Descriptions should be prefixed with server name
    expect(result.tools[0]?.description).toBe("[github] Create a GitHub issue");
  });

  it("returns empty array when no MCP servers exist", async () => {
    const mockDb = createGatewayMockDb({ servers: [], grants: [] });

    const result = await listMcpToolsForAgent(
      mockDb as unknown as Parameters<typeof listMcpToolsForAgent>[0],
      COMPANY_1,
      AGENT_1,
    );

    expect(result.tools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: skill-analysis service MCP integration
// ---------------------------------------------------------------------------

describe("skillAnalysisService MCP tool population", () => {
  afterEach(() => {
    _setClientFactoryForTesting(null);
  });

  it("gracefully degrades to availableMcpTools=[] when listMcpToolsForAgent throws", async () => {
    // Make the client factory throw so the MCP fan-out fails
    _setClientFactoryForTesting(async () => {
      throw new Error("upstream unavailable");
    });

    const { db, mockInsert } = buildSkillAnalysisMockDb({
      plugins: [analyzerPluginRow()],
      servers: [serverARow],
      grants: [grantAgentRow],
    });

    const capturedArgs: { request?: unknown } = {};
    const dispatcher = buildMockDispatcher(capturedArgs);

    const svc = skillAnalysisService(db, { dispatcher });
    const result = await svc.analyze("run-sa-mcp-1");

    // Service should still succeed
    expect(result).not.toBeNull();
    expect(result!.selectedSkills).toEqual(["typescript"]);

    // The request dispatched to the analyzer should have empty MCP tools
    const req = capturedArgs.request as { availableMcpTools?: string[] };
    expect(req?.availableMcpTools).toEqual([]);
  });

  it("passes namespaced tool names in availableMcpTools to the dispatcher", async () => {
    const pooled = makePooledClient(
      [
        { name: "create_issue" },
        { name: "list_issues" },
      ],
      SERVER_A_ID,
    );
    _setClientFactoryForTesting(async () => pooled);

    const { db } = buildSkillAnalysisMockDb({
      plugins: [analyzerPluginRow()],
      servers: [serverARow],
      grants: [grantAgentRow],
    });

    const capturedArgs: { request?: unknown } = {};
    const dispatcher = buildMockDispatcher(capturedArgs);

    const svc = skillAnalysisService(db, { dispatcher });
    const result = await svc.analyze("run-sa-mcp-1");

    expect(result).not.toBeNull();

    // The dispatcher should have received the prefixed tool names
    const req = capturedArgs.request as { availableMcpTools?: string[] };
    expect(req?.availableMcpTools).toEqual(["github__create_issue", "github__list_issues"]);
  });
});
