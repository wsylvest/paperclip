import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { pricingService } from "./pricing.js";
import { getServerAdapter } from "../adapters/index.js";
import type { AdapterEstimateContext, CostEstimate } from "@paperclipai/adapter-utils";
import { parseObject } from "../adapters/utils.js";

/** Default threshold: 50 cents in microcents */
const DEFAULT_THRESHOLD_MICROCENTS = 500_000;
const MIN_THRESHOLD_MICROCENTS = 1_000;

function resolveThresholdMicrocents(): number {
  const envValue = process.env["PAPERCLIP_PRERUN_APPROVAL_THRESHOLD_MICROCENTS"];
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed >= MIN_THRESHOLD_MICROCENTS) {
      return parsed;
    }
  }
  return DEFAULT_THRESHOLD_MICROCENTS;
}

function isGateEnabled(): boolean {
  return process.env["PAPERCLIP_PRERUN_COST_GATE_ENABLED"] === "true";
}

export type PricingGateAction = "proceed" | "block" | "skip";

export interface PricingGateResult {
  action: PricingGateAction;
  estimate?: CostEstimate | null;
  approvalId?: string | null;
  reason?: string;
}

export function pricingGateService(db: Db) {
  const pricing = pricingService(db);

  return {
    check: async (run: typeof heartbeatRuns.$inferSelect): Promise<PricingGateResult> => {
      if (!isGateEnabled()) {
        return { action: "proceed", reason: "gate_disabled" };
      }

      // If a preRunApprovalId is already set, check the approval's current status
      if (run.preRunApprovalId) {
        const existingApproval = await db
          .select()
          .from(approvals)
          .where(eq(approvals.id, run.preRunApprovalId))
          .then((rows) => rows[0] ?? null);

        if (!existingApproval) {
          // Approval row gone — proceed (edge case)
          return { action: "proceed", reason: "approval_not_found" };
        }

        if (existingApproval.status === "approved") {
          return { action: "proceed", approvalId: existingApproval.id };
        }

        if (existingApproval.status === "rejected") {
          // Mark the run as cancelled
          await db
            .update(heartbeatRuns)
            .set({ status: "cancelled", error: "Pre-run cost estimate rejected by operator", errorCode: "pre_run_cost_rejected", updatedAt: new Date() })
            .where(eq(heartbeatRuns.id, run.id));
          return { action: "block", approvalId: existingApproval.id, reason: "rejected" };
        }

        // Still pending
        return { action: "block", approvalId: existingApproval.id, reason: "pending" };
      }

      // No prior approval — try to estimate cost
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) {
        return { action: "skip", reason: "agent_not_found" };
      }

      const adapterModule = agent.adapterType ? getServerAdapter(agent.adapterType) : null;
      if (!adapterModule?.estimateCost) {
        return { action: "skip", reason: "no_estimator" };
      }

      const context = parseObject(run.contextSnapshot);
      const issueId = typeof context.issueId === "string" ? context.issueId : null;

      const estimateCtx: AdapterEstimateContext = {
        agent: {
          id: agent.id,
          companyId: agent.companyId,
          adapterType: agent.adapterType ?? null,
          adapterConfig: agent.adapterConfig,
        },
        taskInput: {
          text: issueId ?? "",
        },
        pricing: {
          estimateFromTokens: (opts: Parameters<typeof pricing.estimateFromTokens>[0]) =>
            pricing.estimateFromTokens(opts),
        },
      };

      let estimate: CostEstimate | null;
      try {
        estimate = await adapterModule.estimateCost(estimateCtx);
      } catch (err) {
        logger.warn({ err, runId: run.id }, "pricing-gate: estimateCost threw, skipping gate");
        return { action: "skip", reason: "estimator_error" };
      }

      if (!estimate) {
        return { action: "skip", reason: "no_estimate" };
      }

      const thresholdMicrocents = resolveThresholdMicrocents();

      // Also derive threshold from agent's monthly budget if set
      const agentThreshold =
        agent.budgetMonthlyCents > 0
          ? Math.floor((agent.budgetMonthlyCents * 10_000) / 100) // 1% of monthly in microcents
          : null;
      const effectiveThreshold = agentThreshold ?? thresholdMicrocents;

      if (estimate.totalCostMicrocents <= effectiveThreshold) {
        return { action: "proceed", estimate, reason: "below_threshold" };
      }

      // Create an approval row
      const context2 = parseObject(run.contextSnapshot);
      const taskPreview = typeof context2.issueId === "string" ? context2.issueId : null;

      const approval = await db
        .insert(approvals)
        .values({
          companyId: run.companyId,
          type: "pre_run_cost_estimate",
          requestedByAgentId: run.agentId,
          status: "pending",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            companyId: run.companyId,
            estimate,
            taskPreview,
            threshold: effectiveThreshold,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]);

      // Stamp the run with the approval id
      await db
        .update(heartbeatRuns)
        .set({ preRunApprovalId: approval.id, updatedAt: new Date() })
        .where(and(eq(heartbeatRuns.id, run.id)));

      return { action: "block", estimate, approvalId: approval.id, reason: "above_threshold" };
    },
  };
}
