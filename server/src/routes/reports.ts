import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { reportQuerySchema, reportExportSchema } from "@paperclipai/shared";
import { reportService } from "../services/reports.js";
import { assertCompanyAccess } from "./authz.js";

export function reportRoutes(db: Db) {
  const router = Router();
  const svc = reportService(db);

  router.get("/companies/:companyId/reports/cost-time-series", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = reportQuerySchema.parse(req.query);
    const result = await svc.costTimeSeries(companyId, parsed);
    res.json(result);
  });

  router.get("/companies/:companyId/reports/agent-performance", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = reportQuerySchema.parse(req.query);
    const result = await svc.agentPerformance(companyId, parsed);
    res.json(result);
  });

  router.get("/companies/:companyId/reports/user-activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = reportQuerySchema.parse(req.query);
    const result = await svc.userActivity(companyId, parsed);
    res.json(result);
  });

  router.get("/companies/:companyId/reports/export", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = reportExportSchema.parse(req.query);
    const data = await svc.exportReport(companyId, parsed);

    if (parsed.format === "csv") {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="report-${parsed.type}-${companyId}.csv"`,
      );
      res.send(data);
      return;
    }

    res.json(data);
  });

  return router;
}
