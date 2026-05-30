import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { heartbeatStageService } from "../services/heartbeat-stages.js";
import { forbidden, notFound } from "../errors.js";

export function heartbeatStageRoutes(db: Db) {
  const router = Router();

  /**
   * GET /api/heartbeat-runs/:runId/stages
   *
   * List all stages for a run. Accessible to:
   *  - Board actors with company access to the run's company.
   *  - Agent actors whose agentId matches the run's agentId.
   */
  router.get("/heartbeat-runs/:runId/stages", async (req, res) => {
    const { runId } = req.params as { runId: string };

    // Resolve the run to get its companyId and agentId.
    const [run] = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));

    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }

    // Auth: board must have company access; agent must own the run.
    if (req.actor.type === "none") {
      throw forbidden("Authentication required");
    }
    if (req.actor.type === "agent") {
      if (req.actor.agentId !== run.agentId) {
        throw forbidden("Agent does not own this run");
      }
    } else {
      // Board actor
      assertCompanyAccess(req, run.companyId);
    }

    const svc = heartbeatStageService(db);
    const stages = await svc.list(runId);
    res.json(stages);
  });

  return router;
}
