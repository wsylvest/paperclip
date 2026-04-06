import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createDeploymentSchema,
  updateDeploymentStatusSchema,
} from "@paperclipai/shared";
import { deploymentService } from "../services/deployments.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function deploymentRoutes(db: Db) {
  const router = Router();
  const svc = deploymentService(db);

  router.get("/companies/:companyId/deployments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.listForCompany(companyId, status ? { status } : undefined);
    res.json(result);
  });

  router.post(
    "/companies/:companyId/deployments",
    validate(createDeploymentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.create(companyId, req.body);
      res.status(201).json(result);
    },
  );

  router.get("/companies/:companyId/deployments/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;
    const result = await svc.getById(companyId, id);
    res.json(result);
  });

  router.put(
    "/companies/:companyId/deployments/:id/status",
    validate(updateDeploymentStatusSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const { status, metadata } = req.body;
      const result = await svc.updateStatus(companyId, id, status, metadata);
      res.json(result);
    },
  );

  router.post("/companies/:companyId/deployments/:id/rollback", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;
    const result = await svc.rollback(companyId, id);
    res.json(result);
  });

  router.post("/companies/:companyId/deployments/:id/health-check", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;
    const result = await svc.checkHealth(companyId, id);
    res.json(result);
  });

  return router;
}
