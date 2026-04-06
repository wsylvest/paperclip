import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  auditEventQuerySchema,
  auditExportQuerySchema,
  upsertAuditRetentionPolicySchema,
} from "@paperclipai/shared";
import { auditService } from "../services/audit.js";
import { assertCompanyAccess } from "./authz.js";

export function auditRoutes(db: Db) {
  const router = Router();
  const svc = auditService(db);

  router.get("/companies/:companyId/audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = auditEventQuerySchema.parse(req.query);
    const result = await svc.query(companyId, {
      ...parsed,
      from: parsed.from ? new Date(parsed.from) : undefined,
      to: parsed.to ? new Date(parsed.to) : undefined,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/audit/export", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = auditExportQuerySchema.parse(req.query);
    const rows = await svc.exportCsv(companyId, {
      ...parsed,
      from: parsed.from ? new Date(parsed.from) : undefined,
      to: parsed.to ? new Date(parsed.to) : undefined,
    });

    if (parsed.format === "json") {
      res.json(rows);
      return;
    }

    // CSV format
    const headers = [
      "id", "companyId", "actorType", "actorId", "category", "action",
      "entityType", "entityId", "severity", "ipAddress", "userAgent",
      "occurredAt", "createdAt",
    ];
    const csvLines = [headers.join(",")];
    for (const row of rows) {
      csvLines.push(
        headers
          .map((h) => {
            const val = (row as Record<string, unknown>)[h];
            if (val == null) return "";
            const str = String(val);
            return str.includes(",") || str.includes('"') || str.includes("\n")
              ? `"${str.replace(/"/g, '""')}"`
              : str;
          })
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-${companyId}.csv"`);
    res.send(csvLines.join("\n"));
  });

  router.get("/companies/:companyId/audit/compliance-summary", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const from = req.query.from ? new Date(req.query.from as string) : undefined;
    const to = req.query.to ? new Date(req.query.to as string) : undefined;
    const summary = await svc.complianceSummary(companyId, { from, to });
    res.json(summary);
  });

  router.get("/companies/:companyId/audit/retention-policies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policies = await svc.getRetentionPolicies(companyId);
    res.json(policies);
  });

  router.put("/companies/:companyId/audit/retention-policies", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = upsertAuditRetentionPolicySchema.parse(req.body);
    const policy = await svc.upsertRetentionPolicy(companyId, input);
    res.json(policy);
  });

  return router;
}
