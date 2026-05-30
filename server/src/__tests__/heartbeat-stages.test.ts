/**
 * heartbeat-stages.test.ts
 *
 * Tests for heartbeatStageService. Uses the embedded-postgres harness so the
 * unique-index race test (test 1c) exercises the real constraint rather than
 * a mock. All other tests benefit from the same real-DB fidelity.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRunStages,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatStageService } from "../services/heartbeat-stages.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat-stages tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeatStageService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Shared fixture data
  let companyId: string;
  let agentId: string;
  let runId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-stages-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeAll(async () => {
    // These are created once and stay for all tests (read-only fixtures).
    companyId = randomUUID();
    agentId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "StagesTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "StagesAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 20_000);

  // Each test creates its own run to avoid cross-test interference.
  async function createRun(): Promise<string> {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
    });
    return id;
  }

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRunStages);
    await db.delete(heartbeatRuns);
  });

  // -------------------------------------------------------------------------
  // Test 1: plan() ordinals
  // -------------------------------------------------------------------------
  it("plan creates stages at successive ordinals and concurrent plans don't collide", async () => {
    runId = await createRun();
    const svc = heartbeatStageService(db);

    const stage1 = await svc.plan(runId, "plan");
    expect(stage1.ordinal).toBe(1);
    expect(stage1.name).toBe("plan");
    expect(stage1.status).toBe("queued");

    const stage2 = await svc.plan(runId, "execute");
    expect(stage2.ordinal).toBe(2);
    expect(stage2.name).toBe("execute");

    // Concurrent plans: if two concurrent calls both compute ordinal 3,
    // one will win the unique index; the service retries once internally.
    // Run 5 concurrent plans to stress it.
    const concurrentResults = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => svc.plan(runId, `concurrent-${i}`)),
    );
    // At least some should succeed (retries handle the collisions)
    const successes = concurrentResults.filter((r) => r.status === "fulfilled");
    const failures = concurrentResults.filter((r) => r.status === "rejected");
    // Retries cover one collision each; some may fail if >2 race the same ordinal slot
    expect(successes.length).toBeGreaterThan(0);
    // Verify ordinals for successful ones are unique
    const ordinals = (successes as PromiseFulfilledResult<typeof stage1>[]).map((r) => r.value.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
    // The failed ones (if any) should be errors (unique-index or retry exhausted).
    // We only verify that failures are Error instances, not other unexpected throws.
    for (const failure of failures as PromiseRejectedResult[]) {
      expect(failure.reason).toBeInstanceOf(Error);
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: start() atomic CAS
  // -------------------------------------------------------------------------
  it("start transitions queued→running; second start returns null", async () => {
    runId = await createRun();
    const svc = heartbeatStageService(db);

    const stage = await svc.plan(runId, "plan");
    expect(stage.status).toBe("queued");

    const started = await svc.start(stage.id);
    expect(started).not.toBeNull();
    expect(started!.status).toBe("running");
    expect(started!.startedAt).not.toBeNull();

    // Second start on an already-running stage returns null (CAS fails).
    const again = await svc.start(stage.id);
    expect(again).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 3: succeed() atomic CAS
  // -------------------------------------------------------------------------
  it("succeed transitions running→succeeded with output; cannot succeed from queued", async () => {
    runId = await createRun();
    const svc = heartbeatStageService(db);

    const stage = await svc.plan(runId, "execute");
    await svc.start(stage.id);

    const output = { result: "ok", items: 42 };
    const succeeded = await svc.succeed(stage.id, output);
    expect(succeeded).not.toBeNull();
    expect(succeeded!.status).toBe("succeeded");
    expect(succeeded!.outputJson).toEqual(output);
    expect(succeeded!.finishedAt).not.toBeNull();

    // Trying to succeed a queued (not running) stage returns null.
    const stage2 = await svc.plan(runId, "metadata");
    const failedSucceed = await svc.succeed(stage2.id, {});
    expect(failedSucceed).toBeNull();
    // Stage2 is still queued.
    const fetched = await svc.get(stage2.id);
    expect(fetched!.status).toBe("queued");
  });

  // -------------------------------------------------------------------------
  // Test 4: fail() mirrors succeed
  // -------------------------------------------------------------------------
  it("fail transitions running→failed and preserves errorClass", async () => {
    runId = await createRun();
    const svc = heartbeatStageService(db);

    const stage = await svc.plan(runId, "media");
    await svc.start(stage.id);

    const failed = await svc.fail(stage.id, "upstream_5xx");
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
    expect(failed!.errorClass).toBe("upstream_5xx");
    expect(failed!.finishedAt).not.toBeNull();

    // Cannot fail from queued.
    const stage2 = await svc.plan(runId, "draft");
    const failedFromQueued = await svc.fail(stage2.id, "some_error");
    expect(failedFromQueued).toBeNull();
    const fetched = await svc.get(stage2.id);
    expect(fetched!.status).toBe("queued");
  });

  // -------------------------------------------------------------------------
  // Test 5: skip() from queued; doesn't work from running
  // -------------------------------------------------------------------------
  it("skip transitions queued→skipped; does not work from running", async () => {
    runId = await createRun();
    const svc = heartbeatStageService(db);

    const stage = await svc.plan(runId, "skill_analysis");
    const skipped = await svc.skip(stage.id, "gate_disabled");
    expect(skipped).not.toBeNull();
    expect(skipped!.status).toBe("skipped");
    expect(skipped!.errorClass).toBe("skipped:gate_disabled");

    // Cannot skip from running — use cancel instead.
    const stage2 = await svc.plan(runId, "another");
    await svc.start(stage2.id);
    const skipRunning = await svc.skip(stage2.id, "some_reason");
    expect(skipRunning).toBeNull();
    const fetched = await svc.get(stage2.id);
    expect(fetched!.status).toBe("running");
  });

  // -------------------------------------------------------------------------
  // Test 6: cancelAllForRun() flips every non-terminal stage
  // -------------------------------------------------------------------------
  it("cancelAllForRun transitions all non-terminal stages to cancelled", async () => {
    runId = await createRun();
    const svc = heartbeatStageService(db);

    const s1 = await svc.plan(runId, "plan");       // queued
    const s2 = await svc.plan(runId, "execute");    // queued → running
    await svc.start(s2.id);
    const s3 = await svc.plan(runId, "publish");    // queued
    // Succeed one stage before cancel to leave it untouched.
    const s4 = await svc.plan(runId, "finalize");   // queued → running → succeeded
    await svc.start(s4.id);
    await svc.succeed(s4.id);

    await svc.cancelAllForRun(runId);

    const stages = await svc.list(runId);
    const byId = Object.fromEntries(stages.map((s) => [s.id, s]));

    expect(byId[s1.id].status).toBe("cancelled");
    expect(byId[s2.id].status).toBe("cancelled");
    expect(byId[s3.id].status).toBe("cancelled");
    // s4 was already succeeded — it must not be touched.
    expect(byId[s4.id].status).toBe("succeeded");
  });

  // -------------------------------------------------------------------------
  // Test 7: each transition writes a heartbeat_run_events row
  // -------------------------------------------------------------------------
  it("each stage transition writes a heartbeat_run_events row with matching eventType", async () => {
    runId = await createRun();
    const svc = heartbeatStageService(db);

    const stage = await svc.plan(runId, "execute");
    // plan → stage.planned
    let events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((e) => e.eventType === "stage.planned")).toBe(true);

    await svc.start(stage.id);
    events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((e) => e.eventType === "stage.started")).toBe(true);

    await svc.succeed(stage.id, { ok: true });
    events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((e) => e.eventType === "stage.succeeded")).toBe(true);

    // Test fail event
    const s2 = await svc.plan(runId, "media");
    await svc.start(s2.id);
    await svc.fail(s2.id, "upstream_5xx");
    events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((e) => e.eventType === "stage.failed")).toBe(true);

    // Test skip event
    const s3 = await svc.plan(runId, "optional");
    await svc.skip(s3.id, "gate_disabled");
    events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((e) => e.eventType === "stage.skipped")).toBe(true);

    // Test cancel event
    const s4 = await svc.plan(runId, "late");
    await svc.cancelAllForRun(runId);
    events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some((e) => e.eventType === "stage.cancelled")).toBe(true);
    void s4; // satisfy no-unused-vars
  });
});
