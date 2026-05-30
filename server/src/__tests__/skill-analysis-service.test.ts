/**
 * skill-analysis-service.test.ts
 *
 * Unit tests for skillAnalysisService. Uses mocked DB and dispatcher — no
 * embedded Postgres required.
 *
 * Tests:
 *  1. No analyzer installed → returns null.
 *  2. Analyzer installed + valid selection → emits skill.selected event.
 *  3. Analyzer returns malformed selection → throws SkillAnalyzerResponseInvalidError.
 *  4. PAPERCLIP_SKILL_ANALYZER_ENABLED=false → returns null without DB activity.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  skillAnalysisService,
  SkillAnalyzerInvocationError,
  SkillAnalyzerResponseInvalidError,
} from "../services/skill-analysis.js";

// ---------------------------------------------------------------------------
// Mock DB factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock DB that returns the shapes the service needs.
 * Overrides are merged at the select() level via a chainable builder.
 */
function buildMockDb(overrides: {
  run?: Record<string, unknown> | null;
  plugins?: Array<Record<string, unknown>>;
  skills?: Array<{ name: string }>;
  maxSeq?: number | null;
} = {}) {
  const run = overrides.run !== undefined
    ? overrides.run
    : {
        id: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        contextSnapshot: { issueTitle: "Fix the login bug", issueBody: "Users cannot log in." },
      };

  const pluginRows = overrides.plugins ?? [];
  const skillRows = overrides.skills ?? [{ name: "typescript" }, { name: "debugging" }];
  const maxSeq = overrides.maxSeq !== undefined ? overrides.maxSeq : 3;

  // Simple call counter: we return different results based on call order within a test.
  let selectCallCount = 0;

  const mockInsert = vi.fn().mockResolvedValue([]);

  const mockDb = {
    select: vi.fn(() => {
      selectCallCount++;
      const callNum = selectCallCount;

      return {
        from: vi.fn(() => ({
          where: vi.fn(() => {
            // Call 1: heartbeatRuns lookup
            if (callNum === 1) return Promise.resolve(run ? [run] : []);
            // Call 2: plugins + pluginCompanySettings join
            if (callNum === 2) return { orderBy: vi.fn(() => Promise.resolve(pluginRows)) };
            // Call 3: companySkills lookup
            if (callNum === 3) return Promise.resolve(skillRows);
            // Call 4: max seq query
            if (callNum === 4) return Promise.resolve([{ maxSeq }]);
            return Promise.resolve([]);
          }),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => Promise.resolve(pluginRows)),
            })),
          })),
          orderBy: vi.fn(() => Promise.resolve([])),
        })),
      };
    }),
    insert: vi.fn(() => ({
      values: mockInsert,
    })),
  };

  return { db: mockDb as unknown as Parameters<typeof skillAnalysisService>[0], mockInsert };
}

// ---------------------------------------------------------------------------
// Mock dispatcher factory
// ---------------------------------------------------------------------------

function buildMockDispatcher(opts: {
  returnContent?: string;
  returnError?: string;
  throws?: Error;
} = {}) {
  const { returnContent, returnError, throws } = opts;
  return {
    executeTool: vi.fn(async () => {
      if (throws) throw throws;
      return {
        pluginId: "plugin-1",
        toolName: "analyzeTask",
        result: {
          content: returnContent,
          error: returnError,
        },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Valid analyzer plugin row shape
// ---------------------------------------------------------------------------

function analyzerPluginRow(pluginKey = "paperclipai.skill-analyzer-keyword-example") {
  return {
    pluginId: "plugin-uuid-1",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skillAnalysisService", () => {
  const originalEnv = process.env.PAPERCLIP_SKILL_ANALYZER_ENABLED;

  afterEach(() => {
    // Restore env flag after each test.
    if (originalEnv === undefined) {
      delete process.env.PAPERCLIP_SKILL_ANALYZER_ENABLED;
    } else {
      process.env.PAPERCLIP_SKILL_ANALYZER_ENABLED = originalEnv;
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: no analyzer installed → null
  // -------------------------------------------------------------------------
  it("returns null when no skill-analyzer plugin is installed for the company", async () => {
    const { db } = buildMockDb({ plugins: [] });
    const dispatcher = buildMockDispatcher();

    const svc = skillAnalysisService(db, { dispatcher });
    const result = await svc.analyze("run-1");

    expect(result).toBeNull();
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: analyzer installed + valid selection → event emitted
  // -------------------------------------------------------------------------
  it("invokes the analyzer and emits a skill.selected event when selection is valid", async () => {
    const validResponse = {
      selectedSkills: ["typescript"],
      selectedMcpTools: [],
      rationale: "Selected 1 skill matching keywords.",
    };

    const { db, mockInsert } = buildMockDb({
      plugins: [analyzerPluginRow()],
    });

    const dispatcher = buildMockDispatcher({
      returnContent: JSON.stringify(validResponse),
    });

    const svc = skillAnalysisService(db, { dispatcher });
    const result = await svc.analyze("run-1");

    expect(result).not.toBeNull();
    expect(result!.selectedSkills).toEqual(["typescript"]);
    expect(result!.rationale).toMatch(/Selected/);

    // Verify the insert (event) was called.
    expect(mockInsert).toHaveBeenCalled();
    const insertedValues = mockInsert.mock.calls[0][0];
    expect(insertedValues.eventType).toBe("skill.selected");
    expect(insertedValues.payload).toMatchObject({
      selectedSkills: ["typescript"],
      selectedMcpTools: [],
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: malformed response → SkillAnalyzerResponseInvalidError
  // -------------------------------------------------------------------------
  it("throws SkillAnalyzerResponseInvalidError when the analyzer returns a malformed payload", async () => {
    const malformedResponse = {
      selectedSkills: "not-an-array",  // should be string[]
      selectedMcpTools: [],
      rationale: "ok",
    };

    const { db, mockInsert } = buildMockDb({
      plugins: [analyzerPluginRow()],
    });

    const dispatcher = buildMockDispatcher({
      returnContent: JSON.stringify(malformedResponse),
    });

    const svc = skillAnalysisService(db, { dispatcher });

    await expect(svc.analyze("run-1")).rejects.toBeInstanceOf(SkillAnalyzerResponseInvalidError);

    // No event row should have been inserted.
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: env flag disabled → null without DB activity
  // -------------------------------------------------------------------------
  it("returns null immediately when PAPERCLIP_SKILL_ANALYZER_ENABLED=false", async () => {
    process.env.PAPERCLIP_SKILL_ANALYZER_ENABLED = "false";

    const { db } = buildMockDb();
    const dispatcher = buildMockDispatcher();

    const svc = skillAnalysisService(db, { dispatcher });
    const result = await svc.analyze("run-1");

    expect(result).toBeNull();

    // The DB and dispatcher should not have been touched.
    expect((db as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
    expect(dispatcher.executeTool).not.toHaveBeenCalled();
  });
});
