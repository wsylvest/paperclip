import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRoutes } from "../routes/mcp.js";
import { errorHandler } from "../middleware/error-handler.js";
import { McpSecretNotFoundError } from "../services/mcp.js";
import { HttpError } from "../errors.js";
import type { HealthCheckResult } from "../services/mcp/health-runner.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockMcpService = vi.hoisted(() => ({
  listServers: vi.fn(),
  getServer: vi.fn(),
  createServer: vi.fn(),
  updateServer: vi.fn(),
  deleteServer: vi.fn(),
  listGrants: vi.fn(),
  createGrant: vi.fn(),
  deleteGrant: vi.fn(),
  listInvocations: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockProbeOneServer = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  mcpService: () => mockMcpService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/mcp/health-runner.js", () => ({
  probeOneServer: (...args: unknown[]) => mockProbeOneServer(...args),
}));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function boardActor(companyId = "company-1") {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    companyIds: [companyId],
    memberships: [{ companyId, status: "active", membershipRole: "admin" }],
  };
}

function createApp(actor: Record<string, unknown> = boardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", mcpRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const SRV_ID = "00000000-0000-0000-0000-000000000001";
const GRANT_ID = "00000000-0000-0000-0000-000000000002";
const INV_ID = "00000000-0000-0000-0000-000000000003";
const AGENT_ID = "00000000-0000-0000-0000-000000000004";
const SECRET_ID = "00000000-0000-0000-0000-000000000005";
const COMPANY_ID = "company-1";

const serverFixture = {
  id: SRV_ID,
  companyId: COMPANY_ID,
  name: "My MCP Server",
  description: null,
  transport: "streamable_http",
  endpoint: "https://mcp.example.com",
  authType: "none",
  authSecretRef: null,
  capabilities: null,
  allowlist: null,
  healthStatus: "unknown",
  healthCheckedAt: null,
  consecutiveFails: 0,
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const grantFixture = {
  id: GRANT_ID,
  companyId: COMPANY_ID,
  mcpServerId: SRV_ID,
  principalType: "agent",
  principalId: AGENT_ID,
  toolAllowlist: null,
  createdByAgentId: null,
  createdByUserId: "user-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const invocationFixture = {
  id: INV_ID,
  companyId: COMPANY_ID,
  runId: "00000000-0000-0000-0000-000000000006",
  agentId: AGENT_ID,
  mcpServerId: SRV_ID,
  toolName: "search",
  requestPayloadHash: null,
  responsePayloadHash: null,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  status: "succeeded",
  errorClass: null,
  costMicrocents: 0,
  approvalId: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockMcpService)) {
      mock.mockReset();
    }
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
    mockProbeOneServer.mockReset();
  });

  // -------------------------------------------------------------------------
  // Auth / access control
  // -------------------------------------------------------------------------

  it("rejects agent callers with 403", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    })).get("/api/companies/company-1/mcp/servers");

    expect(res.status).toBe(403);
    expect(mockMcpService.listServers).not.toHaveBeenCalled();
  });

  it("rejects board user without access to company", async () => {
    const res = await request(createApp(boardActor("company-2")))
      .get("/api/companies/company-1/mcp/servers");

    expect(res.status).toBe(403);
    expect(mockMcpService.listServers).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Servers — list
  // -------------------------------------------------------------------------

  it("lists servers for a company", async () => {
    mockMcpService.listServers.mockResolvedValue([serverFixture]);

    const res = await request(createApp()).get("/api/companies/company-1/mcp/servers");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(SRV_ID);
    expect(mockMcpService.listServers).toHaveBeenCalledWith("company-1");
  });

  // -------------------------------------------------------------------------
  // Servers — get
  // -------------------------------------------------------------------------

  it("gets a single server", async () => {
    mockMcpService.getServer.mockResolvedValue(serverFixture);

    const res = await request(createApp()).get(`/api/companies/company-1/mcp/servers/${SRV_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(SRV_ID);
  });

  it("returns 404 for unknown server", async () => {
    mockMcpService.getServer.mockResolvedValue(null);

    const res = await request(createApp()).get(`/api/companies/company-1/mcp/servers/${GRANT_ID}`);

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Servers — create
  // -------------------------------------------------------------------------

  it("creates a server and returns 201", async () => {
    mockMcpService.createServer.mockResolvedValue(serverFixture);

    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/servers")
      .send({
        name: "My MCP Server",
        endpoint: "https://mcp.example.com",
        transport: "streamable_http",
        authType: "none",
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(SRV_ID);
    expect(mockMcpService.createServer).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "My MCP Server" }),
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "mcp_server.created", entityType: "mcp_server" }),
    );
  });

  it("returns 422 when authSecretRef is not found in company", async () => {
    mockMcpService.createServer.mockRejectedValue(new McpSecretNotFoundError(SECRET_ID));

    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/servers")
      .send({
        name: "My MCP Server",
        endpoint: "https://mcp.example.com",
        transport: "streamable_http",
        authType: "bearer_ref",
        authSecretRef: "00000000-0000-0000-0000-000000000001",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not found/i);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects create when name is missing", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/servers")
      .send({ endpoint: "https://mcp.example.com" });

    expect(res.status).toBe(400);
    expect(mockMcpService.createServer).not.toHaveBeenCalled();
  });

  it("rejects create with authType=bearer_ref but no authSecretRef", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/servers")
      .send({
        name: "My MCP Server",
        endpoint: "https://mcp.example.com",
        authType: "bearer_ref",
      });

    expect(res.status).toBe(400);
    expect(mockMcpService.createServer).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Servers — update
  // -------------------------------------------------------------------------

  it("updates a server", async () => {
    const updated = { ...serverFixture, name: "Renamed" };
    mockMcpService.updateServer.mockResolvedValue(updated);

    const res = await request(createApp())
      .patch(`/api/companies/company-1/mcp/servers/${SRV_ID}`)
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "mcp_server.updated", entityType: "mcp_server" }),
    );
  });

  it("returns 422 when update uses bad authSecretRef", async () => {
    mockMcpService.updateServer.mockRejectedValue(new McpSecretNotFoundError(SECRET_ID));

    const res = await request(createApp())
      .patch(`/api/companies/company-1/mcp/servers/${SRV_ID}`)
      .send({ authSecretRef: SECRET_ID });

    expect(res.status).toBe(422);
  });

  it("returns 404 when updating a server that does not exist", async () => {
    const err = new Error("MCP server not found");
    mockMcpService.updateServer.mockRejectedValue(err);

    const res = await request(createApp())
      .patch(`/api/companies/company-1/mcp/servers/${GRANT_ID}`)
      .send({ name: "New Name" });

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Servers — delete
  // -------------------------------------------------------------------------

  it("deletes a server and returns 204", async () => {
    mockMcpService.getServer.mockResolvedValue(serverFixture);
    mockMcpService.deleteServer.mockResolvedValue(undefined);

    const res = await request(createApp())
      .delete(`/api/companies/company-1/mcp/servers/${SRV_ID}`);

    expect(res.status).toBe(204);
    expect(mockMcpService.deleteServer).toHaveBeenCalledWith("company-1", SRV_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "mcp_server.deleted", entityType: "mcp_server" }),
    );
  });

  it("returns 404 when deleting a server that does not exist", async () => {
    mockMcpService.getServer.mockResolvedValue(null);

    const res = await request(createApp())
      .delete(`/api/companies/company-1/mcp/servers/${GRANT_ID}`);

    expect(res.status).toBe(404);
    expect(mockMcpService.deleteServer).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Cross-company isolation
  // -------------------------------------------------------------------------

  it("does not return servers belonging to another company", async () => {
    // The service is already company-scoped; here we verify the route
    // passes the right companyId and does not accept company-2's board token
    mockMcpService.listServers.mockResolvedValue([]);

    const res = await request(createApp(boardActor("company-2")))
      .get("/api/companies/company-1/mcp/servers");

    expect(res.status).toBe(403);
    expect(mockMcpService.listServers).not.toHaveBeenCalled();
  });

  it("passes the correct companyId to the service for company-2 board users", async () => {
    mockMcpService.listServers.mockResolvedValue([]);

    const res = await request(createApp(boardActor("company-2")))
      .get("/api/companies/company-2/mcp/servers");

    expect(res.status).toBe(200);
    expect(mockMcpService.listServers).toHaveBeenCalledWith("company-2");
  });

  // -------------------------------------------------------------------------
  // Grants — list
  // -------------------------------------------------------------------------

  it("lists grants for a company", async () => {
    mockMcpService.listGrants.mockResolvedValue([grantFixture]);

    const res = await request(createApp()).get("/api/companies/company-1/mcp/grants");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockMcpService.listGrants).toHaveBeenCalledWith("company-1", undefined);
  });

  it("passes serverId filter when provided", async () => {
    mockMcpService.listGrants.mockResolvedValue([grantFixture]);

    const res = await request(createApp())
      .get(`/api/companies/company-1/mcp/grants?serverId=${SRV_ID}`);

    expect(res.status).toBe(200);
    expect(mockMcpService.listGrants).toHaveBeenCalledWith("company-1", SRV_ID);
  });

  // -------------------------------------------------------------------------
  // Grants — create
  // -------------------------------------------------------------------------

  it("creates a grant and returns 201", async () => {
    mockMcpService.createGrant.mockResolvedValue(grantFixture);

    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/grants")
      .send({
        mcpServerId: SRV_ID,
        principalType: "agent",
        principalId: AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(GRANT_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "mcp_server_grant.created", entityType: "mcp_server_grant" }),
    );
  });

  it("creates a company-scoped grant (principalId null)", async () => {
    const companyGrant = { ...grantFixture, id: INV_ID, principalType: "company", principalId: null };
    mockMcpService.createGrant.mockResolvedValue(companyGrant);

    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/grants")
      .send({ mcpServerId: SRV_ID, principalType: "company" });

    expect(res.status).toBe(201);
    expect(res.body.principalType).toBe("company");
  });

  it("rejects grant creation when principalType=agent but principalId is missing", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/grants")
      .send({ mcpServerId: SRV_ID, principalType: "agent" });

    expect(res.status).toBe(400);
    expect(mockMcpService.createGrant).not.toHaveBeenCalled();
  });

  it("rejects grant creation when principalType=company but principalId is set", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/grants")
      .send({
        mcpServerId: SRV_ID,
        principalType: "company",
        principalId: AGENT_ID,
      });

    expect(res.status).toBe(400);
    expect(mockMcpService.createGrant).not.toHaveBeenCalled();
  });

  it("returns 409 when duplicate grant is created", async () => {
    mockMcpService.createGrant.mockRejectedValue(
      new Error("Grant already exists for this server and principal"),
    );

    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/grants")
      .send({
        mcpServerId: SRV_ID,
        principalType: "agent",
        principalId: AGENT_ID,
      });

    expect(res.status).toBe(409);
  });

  it("returns 404 when server for grant does not exist", async () => {
    mockMcpService.createGrant.mockRejectedValue(new Error("MCP server not found"));

    const res = await request(createApp())
      .post("/api/companies/company-1/mcp/grants")
      .send({
        mcpServerId: SRV_ID,
        principalType: "agent",
        principalId: AGENT_ID,
      });

    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Grants — delete
  // -------------------------------------------------------------------------

  it("deletes a grant and returns 204", async () => {
    mockMcpService.listGrants.mockResolvedValue([grantFixture]);
    mockMcpService.deleteGrant.mockResolvedValue(undefined);

    const res = await request(createApp())
      .delete(`/api/companies/company-1/mcp/grants/${GRANT_ID}`);

    expect(res.status).toBe(204);
    expect(mockMcpService.deleteGrant).toHaveBeenCalledWith("company-1", GRANT_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "mcp_server_grant.deleted", entityType: "mcp_server_grant" }),
    );
  });

  it("returns 404 when deleting a grant that does not exist", async () => {
    mockMcpService.listGrants.mockResolvedValue([]);

    const res = await request(createApp())
      .delete(`/api/companies/company-1/mcp/grants/${INV_ID}`);

    expect(res.status).toBe(404);
    expect(mockMcpService.deleteGrant).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Invocations
  // -------------------------------------------------------------------------

  it("returns empty list of invocations by default", async () => {
    mockMcpService.listInvocations.mockResolvedValue([]);

    const res = await request(createApp())
      .get("/api/companies/company-1/mcp/invocations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockMcpService.listInvocations).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ limit: null, runId: null, mcpServerId: null, beforeId: null }),
    );
  });

  it("returns invocations after seeding", async () => {
    mockMcpService.listInvocations.mockResolvedValue([invocationFixture]);

    const res = await request(createApp())
      .get("/api/companies/company-1/mcp/invocations");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(INV_ID);
  });

  it("passes query filters to listInvocations", async () => {
    mockMcpService.listInvocations.mockResolvedValue([]);
    const RUN_ID = "00000000-0000-0000-0000-000000000006";
    const BEFORE_ID = "00000000-0000-0000-0000-000000000007";

    const res = await request(createApp())
      .get(`/api/companies/company-1/mcp/invocations?runId=${RUN_ID}&serverId=${SRV_ID}&limit=50&beforeId=${BEFORE_ID}`);

    expect(res.status).toBe(200);
    expect(mockMcpService.listInvocations).toHaveBeenCalledWith("company-1", {
      runId: RUN_ID,
      mcpServerId: SRV_ID,
      limit: 50,
      beforeId: BEFORE_ID,
    });
  });

  // -------------------------------------------------------------------------
  // Manual probe endpoint
  // -------------------------------------------------------------------------

  it("POST probe on healthy server returns 200 with newStatus:healthy", async () => {
    const probeResult: HealthCheckResult = {
      serverId: SRV_ID,
      companyId: COMPANY_ID,
      previousStatus: "unknown",
      newStatus: "healthy",
      consecutiveFails: 0,
    };
    mockProbeOneServer.mockResolvedValue(probeResult);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/mcp/servers/${SRV_ID}/probe`);

    expect(res.status).toBe(200);
    expect(res.body.newStatus).toBe("healthy");
    expect(res.body.serverId).toBe(SRV_ID);
    expect(mockProbeOneServer).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      SRV_ID,
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "mcp_server.probed",
        entityType: "mcp_server",
        entityId: SRV_ID,
        details: expect.objectContaining({ result: "healthy" }),
      }),
    );
  });

  it("POST probe on server in wrong company returns 404", async () => {
    mockProbeOneServer.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/mcp/servers/${SRV_ID}/probe`);

    expect(res.status).toBe(404);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // surchargeMicrocents validator tests
  // -------------------------------------------------------------------------

  it("POST create server with surchargeMicrocents=1000000 succeeds (valid non-negative integer)", async () => {
    mockMcpService.createServer.mockResolvedValue({
      ...serverFixture,
      surchargeMicrocents: 1000000,
    });

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/mcp/servers`)
      .send({
        name: "Pricey Server",
        transport: "streamable_http",
        endpoint: "https://pricey.example.com",
        authType: "none",
        surchargeMicrocents: 1000000,
      });

    expect(res.status).toBe(201);
    expect(mockMcpService.createServer).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ surchargeMicrocents: 1000000 }),
      expect.anything(),
    );
  });

  it("POST create server with negative surchargeMicrocents returns 400", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_ID}/mcp/servers`)
      .send({
        name: "Invalid Server",
        transport: "streamable_http",
        endpoint: "https://invalid.example.com",
        authType: "none",
        surchargeMicrocents: -1,
      });

    expect(res.status).toBe(400);
    expect(mockMcpService.createServer).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // createMcpServerGrantSchema — requireApprovalTools validation
  // -------------------------------------------------------------------------

  it("createMcpServerGrantSchema accepts requireApprovalTools as string array", async () => {
    const { createMcpServerGrantSchema } = await import("@paperclipai/shared");
    const result = createMcpServerGrantSchema.safeParse({
      mcpServerId: SRV_ID,
      principalType: "agent",
      principalId: AGENT_ID,
      requireApprovalTools: ["t1", "t2"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requireApprovalTools).toEqual(["t1", "t2"]);
    }
  });

  it("createMcpServerGrantSchema rejects requireApprovalTools with non-string entries", async () => {
    const { createMcpServerGrantSchema } = await import("@paperclipai/shared");
    const result = createMcpServerGrantSchema.safeParse({
      mcpServerId: SRV_ID,
      principalType: "agent",
      principalId: AGENT_ID,
      requireApprovalTools: ["t1", 42, null],
    });
    expect(result.success).toBe(false);
  });
});
