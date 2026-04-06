import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  connectAccountingSchema,
  updateChartMappingSchema,
  triggerSyncSchema,
} from "@paperclipai/shared";
import { accountingService } from "../services/accounting.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function accountingRoutes(db: Db) {
  const router = Router();
  const svc = accountingService(db);

  router.get("/companies/:companyId/accounting/connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getConnections(companyId);
    res.json(result);
  });

  router.post(
    "/companies/:companyId/accounting/connect",
    validate(connectAccountingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { provider, redirectUrl } = req.body;
      const result = await svc.initiateOAuthFlow(companyId, provider, redirectUrl);
      res.json(result);
    },
  );

  router.get("/accounting/callback", async (req, res) => {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString());
    const companyId = parsed.companyId as string;
    const provider = (req.query.provider as string) ?? "quickbooks_online";
    const result = await svc.handleOAuthCallback(companyId, provider, code, state);
    res.json(result);
  });

  router.delete("/companies/:companyId/accounting/connections/:connectionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const connectionId = req.params.connectionId as string;
    const result = await svc.disconnect(connectionId);
    res.json(result);
  });

  router.get("/companies/:companyId/accounting/chart-of-accounts/:connectionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const connectionId = req.params.connectionId as string;
    const result = await svc.getChartOfAccounts(connectionId);
    res.json(result);
  });

  router.put(
    "/companies/:companyId/accounting/mappings/:connectionId",
    validate(updateChartMappingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const connectionId = req.params.connectionId as string;
      const { mapping } = req.body;
      const result = await svc.updateAccountMapping(connectionId, mapping);
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/accounting/sync",
    validate(triggerSyncSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      // Find the first active connection for sync
      const connections = await svc.getConnections(companyId);
      const activeConnection = connections.find((c) => c.status === "connected");
      if (!activeConnection) {
        res.json({ syncedCount: 0, errors: ["No active accounting connection"] });
        return;
      }
      const result = await svc.syncInvoicesToAccounting(companyId, activeConnection.id);
      res.json(result);
    },
  );

  router.get("/companies/:companyId/accounting/sync-log", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const connectionId = req.query.connectionId as string | undefined;
    const result = await svc.getSyncLog(companyId, connectionId);
    res.json(result);
  });

  return router;
}
