import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRunStages, heartbeatRuns } from "@paperclipai/db";

export type Stage = typeof heartbeatRunStages.$inferSelect;

const TERMINAL_STATUSES = ["succeeded", "failed", "skipped", "cancelled"] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

async function nextRunEventSeq(db: Db, runId: string): Promise<number> {
  const [row] = await db
    .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
    .from(heartbeatRunEvents)
    .where(eq(heartbeatRunEvents.runId, runId));
  return Number(row?.maxSeq ?? 0) + 1;
}

async function appendStageEvent(
  db: Db,
  run: { id: string; companyId: string; agentId: string },
  stage: Stage,
  eventType: string,
  extra?: Record<string, unknown>,
) {
  const seq = await nextRunEventSeq(db, run.id);
  await db.insert(heartbeatRunEvents).values({
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    seq,
    eventType,
    stream: "system",
    level: "info",
    payload: {
      stageId: stage.id,
      ordinal: stage.ordinal,
      name: stage.name,
      status: stage.status,
      ...extra,
    },
  });
}

async function touchParentRun(db: Db, runId: string) {
  await db
    .update(heartbeatRuns)
    .set({ updatedAt: new Date() })
    .where(eq(heartbeatRuns.id, runId));
}

async function getRunForStage(db: Db, stageId: string) {
  const [row] = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
    })
    .from(heartbeatRunStages)
    .innerJoin(heartbeatRuns, eq(heartbeatRunStages.runId, heartbeatRuns.id))
    .where(eq(heartbeatRunStages.id, stageId));
  return row ?? null;
}

export function heartbeatStageService(db: Db) {
  return {
    async list(runId: string): Promise<Stage[]> {
      return db
        .select()
        .from(heartbeatRunStages)
        .where(eq(heartbeatRunStages.runId, runId))
        .orderBy(heartbeatRunStages.ordinal);
    },

    async get(stageId: string): Promise<Stage | null> {
      const [row] = await db
        .select()
        .from(heartbeatRunStages)
        .where(eq(heartbeatRunStages.id, stageId));
      return row ?? null;
    },

    async plan(runId: string, name: string, inputJson?: unknown): Promise<Stage> {
      // Determine next ordinal with retry on unique-index violation.
      const attempt = async () => {
        const [ordinalRow] = await db
          .select({ maxOrdinal: max(heartbeatRunStages.ordinal) })
          .from(heartbeatRunStages)
          .where(eq(heartbeatRunStages.runId, runId));
        const nextOrdinal = (ordinalRow?.maxOrdinal ?? 0) + 1;

        const [inserted] = await db
          .insert(heartbeatRunStages)
          .values({
            runId,
            ordinal: nextOrdinal,
            name,
            status: "queued",
            inputJson: inputJson !== undefined ? inputJson : null,
          })
          .returning();

        return inserted;
      };

      let stage: Stage;
      try {
        stage = await attempt();
      } catch (err) {
        // Unique index violation on (runId, ordinal) from concurrent insert — retry once.
        // Postgres: code "23505". PGlite may wrap the error differently so also
        // check for message substrings as a fallback.
        const errObj = err as { code?: string; message?: string };
        const isUniqueViolation =
          errObj.code === "23505" ||
          (typeof errObj.message === "string" &&
            (errObj.message.includes("heartbeat_run_stages_run_ordinal_uq") ||
              errObj.message.includes("unique constraint") ||
              errObj.message.includes("duplicate key") ||
              errObj.message.includes("23505")));
        if (!isUniqueViolation) throw err;
        stage = await attempt();
      }

      const run = await getRunForStage(db, stage.id);
      if (run) {
        await appendStageEvent(db, run, stage, "stage.planned");
        await touchParentRun(db, run.id);
      }

      return stage;
    },

    /** Atomic CAS: queued → running. Returns null if already claimed or not found. */
    async start(stageId: string): Promise<Stage | null> {
      const now = new Date();
      const [updated] = await db
        .update(heartbeatRunStages)
        .set({ status: "running", startedAt: now, updatedAt: now })
        .where(and(eq(heartbeatRunStages.id, stageId), eq(heartbeatRunStages.status, "queued")))
        .returning();

      if (!updated) return null;

      const run = await getRunForStage(db, stageId);
      if (run) {
        await appendStageEvent(db, run, updated, "stage.started");
        await touchParentRun(db, run.id);
      }

      return updated;
    },

    /** Atomic CAS: running → succeeded. */
    async succeed(stageId: string, outputJson?: unknown): Promise<Stage | null> {
      const now = new Date();
      const [updated] = await db
        .update(heartbeatRunStages)
        .set({
          status: "succeeded",
          outputJson: outputJson !== undefined ? outputJson : null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(eq(heartbeatRunStages.id, stageId), eq(heartbeatRunStages.status, "running")))
        .returning();

      if (!updated) return null;

      const run = await getRunForStage(db, stageId);
      if (run) {
        await appendStageEvent(db, run, updated, "stage.succeeded", {
          outputJson: updated.outputJson,
        });
        await touchParentRun(db, run.id);
      }

      return updated;
    },

    /** Atomic CAS: running → failed. */
    async fail(stageId: string, errorClass: string): Promise<Stage | null> {
      const now = new Date();
      const [updated] = await db
        .update(heartbeatRunStages)
        .set({ status: "failed", errorClass, finishedAt: now, updatedAt: now })
        .where(and(eq(heartbeatRunStages.id, stageId), eq(heartbeatRunStages.status, "running")))
        .returning();

      if (!updated) return null;

      const run = await getRunForStage(db, stageId);
      if (run) {
        await appendStageEvent(db, run, updated, "stage.failed", { errorClass });
        await touchParentRun(db, run.id);
      }

      return updated;
    },

    /** Atomic CAS: queued → skipped. reason is stored as errorClass with 'skipped:' prefix. */
    async skip(stageId: string, reason: string): Promise<Stage | null> {
      const now = new Date();
      const errorClass = `skipped:${reason}`;
      const [updated] = await db
        .update(heartbeatRunStages)
        .set({ status: "skipped", errorClass, finishedAt: now, updatedAt: now })
        .where(and(eq(heartbeatRunStages.id, stageId), eq(heartbeatRunStages.status, "queued")))
        .returning();

      if (!updated) return null;

      const run = await getRunForStage(db, stageId);
      if (run) {
        await appendStageEvent(db, run, updated, "stage.skipped", { reason });
        await touchParentRun(db, run.id);
      }

      return updated;
    },

    /**
     * Cancel all non-terminal stages for a run. Use this when a caller
     * (route handler, service) wants the cancellation recorded as a
     * heartbeat_run_events row so observers see the action.
     *
     * The cascade-finalize hook (setRunStatus in heartbeat.ts) does NOT
     * call this — it cancels stages inline without writing events, since
     * the run-level transition that triggered the cascade already wrote
     * its own event row and per-stage events would flood the recovery
     * service's recent-events lookback.
     */
    async cancelAllForRun(runId: string): Promise<void> {
      const now = new Date();

      const [runRow] = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));

      if (!runRow) return;

      const updated = await db
        .update(heartbeatRunStages)
        .set({ status: "cancelled", finishedAt: now, updatedAt: now })
        .where(
          and(
            eq(heartbeatRunStages.runId, runId),
            inArray(heartbeatRunStages.status, ["queued", "running"]),
          ),
        )
        .returning();

      for (const stage of updated) {
        await appendStageEvent(db, runRow, stage, "stage.cancelled");
      }

      if (updated.length > 0) {
        await touchParentRun(db, runId);
      }
    },

    /**
     * Finalize all non-terminal stages when a run transitions to a terminal state.
     * Maps run status to stage status: succeeded→succeeded, failed/timed_out→failed,
     * cancelled→cancelled.
     */
    async finalizeStagesForRun(
      runId: string,
      runStatus: "succeeded" | "failed" | "timed_out" | "cancelled",
    ): Promise<void> {
      // Cascade is derivative of the run-level transition that already
      // wrote its own heartbeat_run_events row via setRunStatus. We do
      // NOT append per-stage events here — doing so would flood the
      // recovery service's recent-events lookback (which reads the 8
      // most-recent events to classify liveness) and mask the adapter's
      // actual progress signal. Stages still record the terminal state
      // via the UPDATE below; callers that want the transition history
      // read it from heartbeat_run_stages directly. Same reason we skip
      // touchParentRun here — setRunStatus already bumped updatedAt.
      const now = new Date();
      const stageStatus: TerminalStatus =
        runStatus === "cancelled"
          ? "cancelled"
          : runStatus === "succeeded"
            ? "succeeded"
            : "failed";
      const errorClass = runStatus === "timed_out" ? "timeout" : undefined;

      await db
        .update(heartbeatRunStages)
        .set({
          status: stageStatus,
          finishedAt: now,
          updatedAt: now,
          ...(errorClass ? { errorClass } : {}),
        })
        .where(
          and(
            eq(heartbeatRunStages.runId, runId),
            inArray(heartbeatRunStages.status, ["queued", "running"]),
          ),
        );
    },
  };
}
