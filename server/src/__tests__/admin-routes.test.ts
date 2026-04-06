import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { adminRoutes } from "../routes/admin.js";

const mockAdminDashboardService = vi.hoisted(() => ({
  instanceOverview: vi.fn(),
  companyHealthSummary: vi.fn(),
  userManagementList: vi.fn(),
}));

vi.mock("../services/admin-dashboard.js", () => ({
  adminDashboardService: () => mockAdminDashboardService,
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", adminRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const adminActor = {
  type: "board",
  userId: "local-board",
  source: "local_implicit",
  isInstanceAdmin: true,
};

const nonAdminActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
};

describe("admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /admin/overview", () => {
    it("returns instance metrics for an instance admin", async () => {
      const overview = {
        companyCount: 5,
        userCount: 12,
        agentCount: 30,
        totalSpendCents: 4200,
        activeAgentCount: 8,
        pendingApprovalCount: 2,
      };
      mockAdminDashboardService.instanceOverview.mockResolvedValue(overview);

      const app = createApp(adminActor);
      const res = await request(app).get("/api/admin/overview");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(overview);
      expect(mockAdminDashboardService.instanceOverview).toHaveBeenCalledTimes(1);
    });

    it("rejects non-admin users with 403", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app).get("/api/admin/overview");

      expect(res.status).toBe(403);
      expect(mockAdminDashboardService.instanceOverview).not.toHaveBeenCalled();
    });

    it("rejects agent callers with 403", async () => {
      const app = createApp(agentActor);
      const res = await request(app).get("/api/admin/overview");

      expect(res.status).toBe(403);
      expect(mockAdminDashboardService.instanceOverview).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/companies", () => {
    it("returns company health summaries for an instance admin", async () => {
      const companies = [
        {
          companyId: "c-1",
          companyName: "Acme",
          companyPrefix: "ACM",
          agentCount: 10,
          activeAgentCount: 4,
          memberCount: 3,
          monthSpendCents: 1500,
          lastActivityAt: "2026-04-01T00:00:00Z",
        },
      ];
      mockAdminDashboardService.companyHealthSummary.mockResolvedValue(companies);

      const app = createApp(adminActor);
      const res = await request(app).get("/api/admin/companies");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(companies);
      expect(mockAdminDashboardService.companyHealthSummary).toHaveBeenCalledTimes(1);
    });

    it("rejects non-admin users with 403", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app).get("/api/admin/companies");

      expect(res.status).toBe(403);
      expect(mockAdminDashboardService.companyHealthSummary).not.toHaveBeenCalled();
    });
  });

  describe("GET /admin/users", () => {
    it("returns user management list for an instance admin", async () => {
      const users = [
        {
          userId: "u-1",
          name: "Alice",
          email: "alice@example.com",
          isInstanceAdmin: true,
          memberships: [
            { companyId: "c-1", companyName: "Acme", role: "owner", status: "active" },
          ],
          createdAt: "2026-01-15T00:00:00Z",
        },
        {
          userId: "u-2",
          name: "Bob",
          email: "bob@example.com",
          isInstanceAdmin: false,
          memberships: [],
          createdAt: "2026-02-20T00:00:00Z",
        },
      ];
      mockAdminDashboardService.userManagementList.mockResolvedValue(users);

      const app = createApp(adminActor);
      const res = await request(app).get("/api/admin/users");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(users);
      expect(mockAdminDashboardService.userManagementList).toHaveBeenCalledTimes(1);
    });

    it("rejects non-admin users with 403", async () => {
      const app = createApp(nonAdminActor);
      const res = await request(app).get("/api/admin/users");

      expect(res.status).toBe(403);
      expect(mockAdminDashboardService.userManagementList).not.toHaveBeenCalled();
    });

    it("rejects agent callers with 403", async () => {
      const app = createApp(agentActor);
      const res = await request(app).get("/api/admin/users");

      expect(res.status).toBe(403);
      expect(mockAdminDashboardService.userManagementList).not.toHaveBeenCalled();
    });
  });
});
