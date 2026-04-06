import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  provisionSandboxSchema,
  extendSandboxSchema,
} from "@paperclipai/shared";
import { cloudSandboxService } from "../services/cloud-sandbox.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function cloudSandboxRoutes(db: Db) {
  const router = Router();
  const svc = cloudSandboxService(db);

  router.post(
    "/companies/:companyId/sandboxes",
    validate(provisionSandboxSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.provision(companyId, req.body);
      res.status(201).json(result);
    },
  );

  router.get("/companies/:companyId/sandboxes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listActive(companyId);
    res.json(result);
  });

  router.delete("/companies/:companyId/sandboxes/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;
    const result = await svc.terminate(companyId, id);
    res.json(result);
  });

  router.post(
    "/companies/:companyId/sandboxes/:id/extend",
    validate(extendSandboxSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const { additionalSeconds } = req.body;
      const result = await svc.extend(companyId, id, additionalSeconds);
      res.json(result);
    },
  );

  return router;
}
