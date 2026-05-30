/**
 * Skill analysis service.
 *
 * Runs the configured analyzer plugin for a heartbeat run before the adapter
 * dispatches, narrowing the agent's available skill + MCP tool catalog to what
 * is actually relevant for the task.
 *
 * ORDINAL NOTE (Deviation 1 from the plan doc):
 * The synthetic execute stage inserted by claimQueuedRun sits at ordinal=1.
 * The skill_analysis stage is planned AFTER claim succeeds via
 * heartbeatStageService.plan(), which assigns max(ordinal)+1 = ordinal=2.
 * The runtime semantic ("analyzer runs before adapter dispatch") is preserved;
 * only the cosmetic ordinal numbering differs from the plan's original proposal.
 *
 * ADAPTER CUTOVER DEFERRED (Deviation 2 from the plan doc):
 * Wiring claude-local (or any adapter) to honor the selection is deferred to a
 * follow-up commit. The contract is provable end-to-end via this service,
 * the reference plugin, and the integration tests without any adapter consumer
 * in tree. Per-adapter wiring is mechanical work that benefits from a separate
 * commit so its correctness can be reviewed independently.
 *
 * The runtime hook lives in heartbeat.ts::executeRun (after claim, before
 * adapter dispatch).
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySkills,
  heartbeatRuns,
  heartbeatRunEvents,
  plugins,
  pluginCompanySettings,
} from "@paperclipai/db";
import {
  skillAnalyzerRequestSchema,
  skillAnalyzerResponseSchema,
  type SkillAnalyzerResponse,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SkillSelection = SkillAnalyzerResponse;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown when the analyzer plugin's tool invocation returns an error. */
export class SkillAnalyzerInvocationError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SkillAnalyzerInvocationError";
  }
}

/** Thrown when the analyzer plugin returns a response that fails schema validation. */
export class SkillAnalyzerResponseInvalidError extends Error {
  constructor(
    message: string,
    public readonly zodIssues: Array<{ path: (string | number)[]; message: string }>,
  ) {
    super(message);
    this.name = "SkillAnalyzerResponseInvalidError";
  }
}

// ---------------------------------------------------------------------------
// Dispatcher interface (minimal, injected for testability)
// ---------------------------------------------------------------------------

export interface SkillAnalyzerDispatcher {
  executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: { agentId: string; runId: string; companyId: string },
  ): Promise<{ pluginId: string; toolName: string; result: { content?: string; error?: string } }>;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for heartbeat hook pre-check)
// ---------------------------------------------------------------------------

/**
 * Returns the first enabled skill-analyzer plugin row for a company, or null
 * if none is installed.  Used by the heartbeat hook to decide whether to start
 * (and later succeed) or skip (from queued) the skill_analysis stage without
 * double-counting the stage transition.
 */
export async function findAnalyzerPlugin(
  db: Db,
  companyId: string,
): Promise<{ pluginId: string; pluginKey: string } | null> {
  const rows = await db
    .select({
      pluginId: plugins.id,
      pluginKey: plugins.pluginKey,
      manifestJson: plugins.manifestJson,
      enabled: pluginCompanySettings.enabled,
    })
    .from(plugins)
    .innerJoin(pluginCompanySettings, eq(pluginCompanySettings.pluginId, plugins.id))
    .where(eq(pluginCompanySettings.companyId, companyId))
    .orderBy(plugins.id);

  const match = rows.find((row) => {
    if (!row.enabled) return false;
    const manifest = row.manifestJson as { capabilityTags?: string[] } | null;
    return Array.isArray(manifest?.capabilityTags) && manifest.capabilityTags.includes("skill-analyzer");
  });

  return match ? { pluginId: match.pluginId, pluginKey: match.pluginKey } : null;
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * Create a skill analysis service.
 *
 * The dispatcher is injected so the service can be tested without a live
 * plugin worker process.
 */
export function skillAnalysisService(
  db: Db,
  opts: { dispatcher: SkillAnalyzerDispatcher },
) {
  const { dispatcher } = opts;

  return {
    /**
     * Returns the selection emitted by the analyzer, or null if no analyzer is
     * installed/enabled for the run's company (caller should skip the stage).
     *
     * Throws SkillAnalyzerInvocationError or SkillAnalyzerResponseInvalidError
     * on failure. Does NOT fall back to "use all skills" — a misbehaving
     * analyzer must be loud.
     *
     * Side effect: inserts a heartbeat_run_events row with
     * eventType='skill.selected' when a selection is produced.
     */
    async analyze(runId: string): Promise<SkillSelection | null> {
      // Respect the kill switch: PAPERCLIP_SKILL_ANALYZER_ENABLED=false skips
      // without any DB activity.
      const envFlag = process.env.PAPERCLIP_SKILL_ANALYZER_ENABLED;
      if (typeof envFlag === "string" && envFlag.toLowerCase() === "false") {
        logger.debug({ runId }, "skill-analysis: disabled via PAPERCLIP_SKILL_ANALYZER_ENABLED=false");
        return null;
      }

      // 1. Look up the run to get companyId and agentId.
      const [run] = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));

      if (!run) {
        logger.warn({ runId }, "skill-analysis: run not found; skipping");
        return null;
      }

      const { companyId, agentId } = run;

      // 2. Find an enabled analyzer plugin for this company.
      //    We join plugins with pluginCompanySettings, then filter in TS for
      //    the capabilityTags check (jsonb containment for a non-indexed field
      //    would be fragile across PGlite vs Postgres; TS filter is simple and
      //    correct with small plugin counts).
      const rows = await db
        .select({
          pluginId: plugins.id,
          pluginKey: plugins.pluginKey,
          manifestJson: plugins.manifestJson,
          enabled: pluginCompanySettings.enabled,
        })
        .from(plugins)
        .innerJoin(
          pluginCompanySettings,
          eq(pluginCompanySettings.pluginId, plugins.id),
        )
        .where(eq(pluginCompanySettings.companyId, companyId))
        .orderBy(plugins.id);

      const analyzerPlugins = rows.filter((row) => {
        if (!row.enabled) return false;
        const manifest = row.manifestJson as { capabilityTags?: string[] } | null;
        return Array.isArray(manifest?.capabilityTags) &&
          manifest.capabilityTags.includes("skill-analyzer");
      });

      if (analyzerPlugins.length === 0) {
        logger.debug({ runId, companyId }, "skill-analysis: no skill-analyzer plugin installed; skipping");
        return null;
      }

      // Pick the first (lowest id) for deterministic selection.
      const analyzerPlugin = analyzerPlugins[0]!;

      // 3. Pull task context from contextSnapshot.
      const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
      const taskTitle = typeof context.issueTitle === "string" ? context.issueTitle : "";
      const taskBody = typeof context.issueBody === "string" ? context.issueBody : "";

      // 4. Look up available skills for this company.
      const skillRows = await db
        .select({ name: companySkills.name })
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId));
      const availableSkills = skillRows.map((r) => r.name);

      // 5. MCP tool list is deferred — requires gateway client pool fan-out.
      //    TODO: populate availableMcpTools via MCP gateway in a follow-up commit.
      const availableMcpTools: string[] = [];

      // 6. Build and defensively validate the request (should always succeed).
      const requestPayload = skillAnalyzerRequestSchema.parse({
        taskTitle,
        taskBody,
        availableSkills,
        availableMcpTools,
      });

      // 7. Dispatch the analyzeTask tool.
      //    Namespacing: "<pluginKey>:analyzeTask"
      const namespacedName = `${analyzerPlugin.pluginKey}:analyzeTask`;

      logger.debug(
        { runId, companyId, agentId, pluginKey: analyzerPlugin.pluginKey, namespacedName },
        "skill-analysis: dispatching analyzeTask",
      );

      let dispatchResult: Awaited<ReturnType<SkillAnalyzerDispatcher["executeTool"]>>;
      try {
        dispatchResult = await dispatcher.executeTool(namespacedName, requestPayload, {
          agentId,
          runId,
          companyId,
        });
      } catch (err) {
        throw new SkillAnalyzerInvocationError(
          `analyzeTask dispatch failed for plugin "${analyzerPlugin.pluginKey}": ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      // 8. Check for tool-level error.
      if (dispatchResult.result.error) {
        throw new SkillAnalyzerInvocationError(
          `analyzeTask returned an error from plugin "${analyzerPlugin.pluginKey}": ${dispatchResult.result.error}`,
        );
      }

      // 9. Parse the content string.
      const rawContent = dispatchResult.result.content;
      if (typeof rawContent !== "string" || rawContent.trim() === "") {
        throw new SkillAnalyzerInvocationError(
          `analyzeTask from plugin "${analyzerPlugin.pluginKey}" returned empty or non-string content`,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch (err) {
        throw new SkillAnalyzerInvocationError(
          `analyzeTask from plugin "${analyzerPlugin.pluginKey}" returned non-JSON content`,
          err,
        );
      }

      // 10. Validate response shape. Throw loudly; do NOT fall back.
      const validated = skillAnalyzerResponseSchema.safeParse(parsed);
      if (!validated.success) {
        throw new SkillAnalyzerResponseInvalidError(
          `analyzeTask response from plugin "${analyzerPlugin.pluginKey}" failed schema validation`,
          validated.error.issues,
        );
      }

      const selection = validated.data;

      // 11. Emit a skill.selected event into heartbeat_run_events.
      const [maxSeqRow] = await db
        .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
      const nextSeq = Number(maxSeqRow?.maxSeq ?? 0) + 1;

      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId,
        agentId,
        seq: nextSeq,
        eventType: "skill.selected",
        stream: "system",
        level: "info",
        payload: selection as unknown as Record<string, unknown>,
      });

      logger.info(
        {
          runId,
          companyId,
          agentId,
          pluginKey: analyzerPlugin.pluginKey,
          selectedSkillCount: selection.selectedSkills.length,
          selectedMcpToolCount: selection.selectedMcpTools.length,
        },
        "skill-analysis: selection complete",
      );

      return selection;
    },
  };
}
