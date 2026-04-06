import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { adminDashboardService } from "../services/admin-dashboard.js";
import { assertInstanceAdmin } from "./authz.js";

export function adminRoutes(db: Db) {
  const router = Router();
  const svc = adminDashboardService(db);

  router.get("/admin/overview", async (req, res) => {
    assertInstanceAdmin(req);
    const overview = await svc.instanceOverview();
    res.json(overview);
  });

  router.get("/admin/companies", async (req, res) => {
    assertInstanceAdmin(req);
    const companies = await svc.companyHealthSummary();
    res.json(companies);
  });

  router.get("/admin/users", async (req, res) => {
    assertInstanceAdmin(req);
    const users = await svc.userManagementList();
    res.json(users);
  });

  return router;
}
