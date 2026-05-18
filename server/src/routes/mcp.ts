import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createMcpServerGrantSchema,
  createMcpServerSchema,
  updateMcpServerSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, mcpService } from "../services/index.js";
import { McpSecretNotFoundError } from "../services/mcp.js";
import { probeOneServer } from "../services/mcp/health-runner.js";
import { conflict, notFound } from "../errors.js";

export function mcpRoutes(db: Db) {
  const router = Router();
  const svc = mcpService(db);

  // ---------------------------------------------------------------------------
  // Servers
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/mcp/servers", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const servers = await svc.listServers(companyId);
    res.json(servers);
  });

  router.get("/companies/:companyId/mcp/servers/:id", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const server = await svc.getServer(companyId, req.params.id as string);
    if (!server) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }
    res.json(server);
  });

  router.post(
    "/companies/:companyId/mcp/servers",
    validate(createMcpServerSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      let created;
      try {
        created = await svc.createServer(
          companyId,
          {
            name: req.body.name,
            description: req.body.description,
            transport: req.body.transport,
            endpoint: req.body.endpoint,
            authType: req.body.authType,
            authSecretRef: req.body.authSecretRef,
            capabilities: req.body.capabilities,
            allowlist: req.body.allowlist,
            surchargeMicrocents: req.body.surchargeMicrocents,
          },
          { userId: req.actor.userId ?? null, agentId: null },
        );
      } catch (err) {
        if (err instanceof McpSecretNotFoundError) {
          res.status(422).json({ error: err.message });
          return;
        }
        throw err;
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "mcp_server.created",
        entityType: "mcp_server",
        entityId: created.id,
        details: { name: created.name, transport: created.transport },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/mcp/servers/:id",
    validate(updateMcpServerSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const id = req.params.id as string;

      let updated;
      try {
        updated = await svc.updateServer(
          companyId,
          id,
          {
            name: req.body.name,
            description: req.body.description,
            transport: req.body.transport,
            endpoint: req.body.endpoint,
            authType: req.body.authType,
            authSecretRef: req.body.authSecretRef,
            capabilities: req.body.capabilities,
            allowlist: req.body.allowlist,
            surchargeMicrocents: req.body.surchargeMicrocents,
          },
          { userId: req.actor.userId ?? null, agentId: null },
        );
      } catch (err) {
        if (err instanceof McpSecretNotFoundError) {
          res.status(422).json({ error: err.message });
          return;
        }
        if (err instanceof Error && err.message === "MCP server not found") {
          res.status(404).json({ error: "MCP server not found" });
          return;
        }
        throw err;
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "mcp_server.updated",
        entityType: "mcp_server",
        entityId: updated.id,
        details: { name: updated.name },
      });

      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/mcp/servers/:id", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;

    const existing = await svc.getServer(companyId, id);
    if (!existing) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    await svc.deleteServer(companyId, id);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "mcp_server.deleted",
      entityType: "mcp_server",
      entityId: id,
      details: { name: existing.name },
    });

    res.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Manual probe
  // ---------------------------------------------------------------------------

  router.post("/companies/:companyId/mcp/servers/:id/probe", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;

    const result = await probeOneServer(db, companyId, id);
    if (!result) {
      res.status(404).json({ error: "MCP server not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "mcp_server.probed",
      entityType: "mcp_server",
      entityId: id,
      details: { result: result.newStatus },
    });

    res.json(result);
  });

  // ---------------------------------------------------------------------------
  // Grants
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/mcp/grants", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const serverId = typeof req.query.serverId === "string" ? req.query.serverId : undefined;
    const grants = await svc.listGrants(companyId, serverId);
    res.json(grants);
  });

  router.post(
    "/companies/:companyId/mcp/grants",
    validate(createMcpServerGrantSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      let created;
      try {
        created = await svc.createGrant(
          companyId,
          {
            mcpServerId: req.body.mcpServerId,
            principalType: req.body.principalType,
            principalId: req.body.principalId,
            toolAllowlist: req.body.toolAllowlist,
            requireApprovalTools: req.body.requireApprovalTools,
          },
          { userId: req.actor.userId ?? null, agentId: null },
        );
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === "MCP server not found") {
            res.status(404).json({ error: "MCP server not found" });
            return;
          }
          if (err.message.includes("Grant already exists")) {
            res.status(409).json({ error: err.message });
            return;
          }
        }
        throw err;
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "mcp_server_grant.created",
        entityType: "mcp_server_grant",
        entityId: created.id,
        details: {
          mcpServerId: created.mcpServerId,
          principalType: created.principalType,
          principalId: created.principalId,
        },
      });

      res.status(201).json(created);
    },
  );

  router.delete("/companies/:companyId/mcp/grants/:id", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;

    let deletedId = id;
    let mcpServerId: string | undefined;
    let principalType: string | undefined;
    let principalId: string | null | undefined;

    try {
      // Fetch info before delete for activity log
      const grants = await svc.listGrants(companyId);
      const grant = grants.find((g) => g.id === id);
      if (!grant) {
        res.status(404).json({ error: "MCP server grant not found" });
        return;
      }
      mcpServerId = grant.mcpServerId;
      principalType = grant.principalType;
      principalId = grant.principalId;
      await svc.deleteGrant(companyId, id);
    } catch (err) {
      if (err instanceof Error && err.message === "MCP server grant not found") {
        res.status(404).json({ error: "MCP server grant not found" });
        return;
      }
      throw err;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "mcp_server_grant.deleted",
      entityType: "mcp_server_grant",
      entityId: deletedId,
      details: { mcpServerId, principalType, principalId },
    });

    res.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Invocations (read-only)
  // ---------------------------------------------------------------------------

  router.get("/companies/:companyId/mcp/invocations", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const invocations = await svc.listInvocations(companyId, {
      runId: typeof req.query.runId === "string" ? req.query.runId : null,
      mcpServerId: typeof req.query.serverId === "string" ? req.query.serverId : null,
      limit: Number.isFinite(limit) ? limit : null,
      beforeId: typeof req.query.beforeId === "string" ? req.query.beforeId : null,
    });

    res.json(invocations);
  });

  return router;
}
