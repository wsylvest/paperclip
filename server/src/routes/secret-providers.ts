import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { configureProviderSchema } from "@paperclipai/shared";
import { secretProviderConfigService } from "../services/secret-provider-config.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function secretProviderRoutes(db: Db) {
  const router = Router();
  const svc = secretProviderConfigService(db);

  router.get("/companies/:companyId/secret-providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.post(
    "/companies/:companyId/secret-providers",
    validate(configureProviderSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.configure(companyId, req.body);
      res.status(201).json(result);
    },
  );

  router.post(
    "/companies/:companyId/secret-providers/:id/test",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const result = await svc.testConnection(companyId, id);
      res.json(result);
    },
  );

  router.delete(
    "/companies/:companyId/secret-providers/:id",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;
      const result = await svc.remove(companyId, id);
      res.json(result);
    },
  );

  return router;
}
