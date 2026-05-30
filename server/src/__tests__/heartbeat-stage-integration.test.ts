/**
 * heartbeat-stage-integration.test.ts
 *
 * Integration tests for the stage lifecycle wired into heartbeat.ts:
 *  1. Claiming a run with no stages auto-creates the synthetic 'execute' stage.
 *  2. Finalizing a run with a running stage transitions the stage to the matching terminal.
 *  3. A cost_events row written with a stageId carries that id through costService.createEvent.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRunStages,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { heartbeatStageService } from "../services/heartbeat-stages.js";
import { costService } from "../services/costs.js";

// ---------------------------------------------------------------------------
// Mock adapter so executeRun does not actually spawn processes
// ---------------------------------------------------------------------------
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stage integration test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// ---------------------------------------------------------------------------
// Embedded-postgres gate
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat-stage-integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describeEmbeddedPostgres("heartbeat stage integration", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-stage-integration-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stage integration test run.",
      provider: "test",
      model: "test-model",
    }));

    // Wait for any async run executions to settle before deleting.
    for (let attempt = 0; attempt < 60; attempt++) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActive = runs.some((r) => r.status === "queued" || r.status === "running");
      if (!hasActive) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRunStages);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  async function seedAgent(opts: { adapterType?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `I${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "IntegrationTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "StageBot",
      role: "engineer",
      status: "active",
      adapterType: opts.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  // -------------------------------------------------------------------------
  // Test 1: synthetic 'execute' stage auto-created on claim
  // -------------------------------------------------------------------------
  it("claiming a queued run with no pre-existing stages auto-creates the synthetic execute stage", async () => {
    const { agentId } = await seedAgent();

    const queuedRun = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    expect(queuedRun).not.toBeNull();
    const runId = queuedRun!.id;

    // Run a heartbeat cycle so claimQueuedRun fires.
    await heartbeat.resumeQueuedRuns();

    // Wait for the adapter to complete (async execution).
    const done = await waitForCondition(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return !!run && run.status !== "queued" && run.status !== "running";
    });
    expect(done).toBe(true);

    // Verify at least one stage row for this run exists.
    const stages = await db
      .select()
      .from(heartbeatRunStages)
      .where(eq(heartbeatRunStages.runId, runId));

    expect(stages.length).toBeGreaterThanOrEqual(1);
    const executeStage = stages.find((s) => s.name === "execute");
    expect(executeStage).toBeDefined();
    expect(executeStage!.ordinal).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 2: cascade finalize — running stage transitions to terminal on run end
  // -------------------------------------------------------------------------
  it("finalizing a run transitions its running stages to the matching terminal state", async () => {
    const { agentId, companyId } = await seedAgent();

    // Insert a run directly in "running" state with an explicit stage in "running".
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      startedAt: new Date(),
    });

    const svc = heartbeatStageService(db);
    const stage = await svc.plan(runId, "execute");
    await svc.start(stage.id);

    // Confirm stage is running.
    const before = await svc.get(stage.id);
    expect(before!.status).toBe("running");

    // Cancel the run (triggers cascade finalize via setRunStatus).
    await heartbeat.cancelRun(runId);

    const after = await svc.get(stage.id);
    expect(after!.status).toBe("cancelled");
  });

  // -------------------------------------------------------------------------
  // Test 3: cost_events row with stageId carries that id
  // -------------------------------------------------------------------------
  it("a cost event written with a stageId stores that stageId on the row", async () => {
    const { agentId, companyId } = await seedAgent();

    // Create a run and a stage.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      startedAt: new Date(),
    });

    const svc = heartbeatStageService(db);
    const stage = await svc.plan(runId, "execute");
    await svc.start(stage.id);

    // Write a cost event linked to this stage.
    const costSvc = costService(db);
    const event = await costSvc.createEvent(companyId, {
      agentId,
      heartbeatRunId: runId,
      stageId: stage.id,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 1,
      occurredAt: new Date(),
    });

    expect(event.stageId).toBe(stage.id);

    // Re-fetch from DB to confirm persistence.
    const [row] = await db.select().from(costEvents).where(eq(costEvents.id, event.id));
    expect(row.stageId).toBe(stage.id);
  });
});
