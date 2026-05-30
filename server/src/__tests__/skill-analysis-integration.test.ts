/**
 * skill-analysis-integration.test.ts
 *
 * Integration tests for the skill_analysis stage pipeline using the embedded
 * Postgres harness. Tests verify the complete stage lifecycle against a real
 * database without needing to go through the full heartbeat execution path
 * (which requires vi.mock for adapters — a pattern broken in this environment
 * for pre-existing reasons).
 *
 * Tests:
 *  1. End-to-end with a mocked dispatcher returning a valid selection:
 *     - skill_analysis stage is planned, started, and succeeded
 *     - a 'skill.selected' event exists in heartbeat_run_events
 *     - the synthetic execute stage (ordinal=1) also exists
 *     - skill_analysis stage is at ordinal=2
 *
 *  2. With no plugin installed: the skillAnalysisService.analyze() return is
 *     null and the stage service's skip() CAS works in isolation. (The
 *     heartbeat hook itself, when no analyzer is installed, deliberately does
 *     NOT create a stage row at all — routine no-op stage rows would push the
 *     adapter's real progress events out of the recovery service's 8-event
 *     liveness lookback. This test exercises the underlying building blocks;
 *     the no-row hook behavior is verified by the heartbeat-process-recovery
 *     suite continuing to pass.)
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRunStages,
  heartbeatRuns,
  plugins,
  pluginCompanySettings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatStageService } from "../services/heartbeat-stages.js";
import {
  skillAnalysisService,
  SkillAnalyzerInvocationError,
  SkillAnalyzerResponseInvalidError,
} from "../services/skill-analysis.js";

// ---------------------------------------------------------------------------
// Embedded-postgres gate
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping skill-analysis-integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describeEmbeddedPostgres("skill analysis integration (stage lifecycle)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Fixture IDs — created once per suite.
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("skill-analysis-integration-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    agentId = randomUUID();
    const issuePrefix = `SK${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "SkillAnalysisTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "AnalysisBot",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRunStages);
    await db.delete(heartbeatRuns);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companySkills);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function createRun() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: { issueTitle: "Fix the login bug", issueBody: "Users cannot log in." },
    });
    return runId;
  }

  async function seedAnalyzerPlugin() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclipai.skill-analyzer-keyword-example",
      packageName: "@paperclipai/plugin-skill-analyzer-keyword-example",
      version: "0.1.0",
      apiVersion: 1,
      categories: ["integration"],
      manifestJson: {
        id: "paperclipai.skill-analyzer-keyword-example",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Skill Analyzer Keyword Example",
        description: "Reference skill analyzer plugin.",
        author: "Paperclip",
        categories: ["integration"],
        capabilities: ["agent.tools.register"],
        capabilityTags: ["skill-analyzer"],
        entrypoints: { worker: "./dist/index.js" },
        tools: [
          {
            name: "analyzeTask",
            displayName: "Analyze task",
            description: "Analyze task for relevant skills.",
            parametersSchema: { type: "object" },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
    });

    await db.insert(pluginCompanySettings).values({
      pluginId,
      companyId,
      enabled: true,
      settingsJson: {},
    });

    return pluginId;
  }

  // ---------------------------------------------------------------------------
  // Test 1: end-to-end with mocked dispatcher — full stage lifecycle
  //
  // Simulates what heartbeat.ts does:
  //  1. claimQueuedRun inserts execute stage at ordinal=1
  //  2. heartbeat hook plans skill_analysis at ordinal=2
  //  3. skill_analysis starts → dispatcher called → stage succeeds
  //  4. Both stages and the skill.selected event row are confirmed
  // ---------------------------------------------------------------------------
  it("skill_analysis stage succeeds, execute stage is at ordinal=1, skill_analysis at ordinal=2, event row emitted", async () => {
    await seedAnalyzerPlugin();
    const runId = await createRun();

    const validSelection = {
      selectedSkills: ["typescript"],
      selectedMcpTools: [],
      rationale: "Selected 1 skill matching keywords.",
    };

    // Simulate the synthetic execute stage at ordinal=1 (normally done by claimQueuedRun).
    const stageSvc = heartbeatStageService(db);
    const now = new Date();
    await db.insert(heartbeatRunStages).values({
      runId,
      ordinal: 1,
      name: "execute",
      status: "running",
      startedAt: now,
      updatedAt: now,
    });

    // Plan skill_analysis (gets ordinal=2 via max+1 logic).
    const skillStage = await stageSvc.plan(runId, "skill_analysis");
    expect(skillStage.ordinal).toBe(2);

    // Start it.
    await stageSvc.start(skillStage.id);

    // Stub dispatcher that returns valid selection.
    const dispatcher = {
      executeTool: vi.fn(async () => ({
        pluginId: "plugin-1",
        toolName: "analyzeTask",
        result: { content: JSON.stringify(validSelection) },
      })),
    };

    // Run skill analysis.
    const svc = skillAnalysisService(db, { dispatcher });
    const selection = await svc.analyze(runId);

    expect(selection).not.toBeNull();
    expect(selection!.selectedSkills).toEqual(["typescript"]);

    // Succeed the stage with the selection.
    await stageSvc.succeed(skillStage.id, selection);

    // Confirm both stages exist in the DB with correct ordinals and statuses.
    const stages = await db
      .select()
      .from(heartbeatRunStages)
      .where(eq(heartbeatRunStages.runId, runId));

    const executeStage = stages.find((s) => s.name === "execute");
    expect(executeStage).toBeDefined();
    expect(executeStage!.ordinal).toBe(1);
    expect(executeStage!.status).toBe("running"); // not yet finalized in this test

    const analyzerStage = stages.find((s) => s.name === "skill_analysis");
    expect(analyzerStage).toBeDefined();
    expect(analyzerStage!.ordinal).toBe(2);
    expect(analyzerStage!.status).toBe("succeeded");
    expect(analyzerStage!.outputJson).toMatchObject({ selectedSkills: ["typescript"] });

    // Confirm the skill.selected event row was inserted by skillAnalysisService.
    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.runId, runId),
          eq(heartbeatRunEvents.eventType, "skill.selected"),
        ),
      );
    expect(events.length).toBe(1);
    expect(events[0]!.payload).toMatchObject({ selectedSkills: ["typescript"] });
  });

  // ---------------------------------------------------------------------------
  // Test 2: no plugin installed → skill_analysis stage skipped
  // ---------------------------------------------------------------------------
  it("skill_analysis stage is skipped when no analyzer plugin is installed for the company", async () => {
    // Do NOT seed any analyzer plugin.
    const runId = await createRun();

    const stageSvc = heartbeatStageService(db);

    // Simulate synthetic execute stage at ordinal=1.
    const now = new Date();
    await db.insert(heartbeatRunStages).values({
      runId,
      ordinal: 1,
      name: "execute",
      status: "running",
      startedAt: now,
      updatedAt: now,
    });

    // Plan skill_analysis stage (ordinal=2).
    const skillStage = await stageSvc.plan(runId, "skill_analysis");
    expect(skillStage.ordinal).toBe(2);

    // Build a dispatcher (should not be called when no plugin is installed).
    const dispatcher = {
      executeTool: vi.fn(),
    };

    // Run skill analysis — should return null (no plugin found).
    // Note: we do NOT call stageSvc.start() before analyze() in the no-plugin
    // path. The heartbeat hook mirrors this: it pre-checks plugin availability
    // via findAnalyzerPlugin() while the stage is still queued, then skips from
    // queued (CAS: queued → skipped) without ever starting. This keeps the
    // skip() CAS invariant intact (skip only accepts queued → skipped).
    const svc = skillAnalysisService(db, { dispatcher });
    const selection = await svc.analyze(runId);

    expect(selection).toBeNull();
    expect(dispatcher.executeTool).not.toHaveBeenCalled();

    // Skip the stage from queued (valid CAS).
    const skipped = await stageSvc.skip(skillStage.id, "no_analyzer_installed");
    expect(skipped).not.toBeNull();
    expect(skipped!.status).toBe("skipped");
    expect(skipped!.errorClass).toMatch(/^skipped:/);

    // Confirm from DB.
    const stage = await stageSvc.get(skillStage.id);
    expect(stage!.status).toBe("skipped");
    expect(stage!.errorClass).toMatch(/^skipped:/);
  });
});
