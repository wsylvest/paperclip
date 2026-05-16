import { and, asc, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, mcpInvocations, mcpServerGrants, mcpServers } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

export class McpSecretNotFoundError extends Error {
  constructor(secretRef: string) {
    super(`Secret ref not found in company: ${secretRef}`);
    this.name = "McpSecretNotFoundError";
  }
}

export function mcpService(db: Db) {
  // -------------------------------------------------------------------------
  // Servers
  // -------------------------------------------------------------------------

  async function listServers(companyId: string) {
    return db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.companyId, companyId))
      .orderBy(asc(mcpServers.name));
  }

  async function getServer(companyId: string, id: string) {
    return db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.companyId, companyId), eq(mcpServers.id, id)))
      .then((rows) => rows[0] ?? null);
  }

  async function assertAuthSecretRefInCompany(
    companyId: string,
    authSecretRef: string | null | undefined,
  ) {
    if (!authSecretRef) return;
    const secret = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(and(eq(companySecrets.id, authSecretRef), eq(companySecrets.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!secret) {
      throw new McpSecretNotFoundError(authSecretRef);
    }
  }

  async function createServer(
    companyId: string,
    input: {
      name: string;
      description?: string | null;
      transport?: string;
      endpoint: string;
      authType?: string;
      authSecretRef?: string | null;
      capabilities?: Record<string, unknown> | null;
      allowlist?: Record<string, unknown> | null;
    },
    actor: { userId?: string | null; agentId?: string | null },
  ) {
    await assertAuthSecretRefInCompany(companyId, input.authSecretRef);

    return db
      .insert(mcpServers)
      .values({
        companyId,
        name: input.name,
        description: input.description ?? null,
        transport: input.transport ?? "streamable_http",
        endpoint: input.endpoint,
        authType: input.authType ?? "none",
        authSecretRef: input.authSecretRef ?? null,
        capabilities: input.capabilities ?? null,
        allowlist: input.allowlist ?? null,
        createdByUserId: actor.userId ?? null,
        createdByAgentId: actor.agentId ?? null,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function updateServer(
    companyId: string,
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      transport?: string;
      endpoint?: string;
      authType?: string;
      authSecretRef?: string | null;
      capabilities?: Record<string, unknown> | null;
      allowlist?: Record<string, unknown> | null;
    },
    actor: { userId?: string | null; agentId?: string | null },
  ) {
    const existing = await getServer(companyId, id);
    if (!existing) throw notFound("MCP server not found");

    if (patch.authSecretRef !== undefined) {
      await assertAuthSecretRefInCompany(companyId, patch.authSecretRef);
    }

    return db
      .update(mcpServers)
      .set({
        name: patch.name ?? existing.name,
        description: patch.description === undefined ? existing.description : patch.description,
        transport: patch.transport ?? existing.transport,
        endpoint: patch.endpoint ?? existing.endpoint,
        authType: patch.authType ?? existing.authType,
        authSecretRef: patch.authSecretRef === undefined ? existing.authSecretRef : patch.authSecretRef,
        capabilities: patch.capabilities === undefined ? existing.capabilities : patch.capabilities,
        allowlist: patch.allowlist === undefined ? existing.allowlist : patch.allowlist,
        updatedAt: new Date(),
      })
      .where(and(eq(mcpServers.companyId, companyId), eq(mcpServers.id, id)))
      .returning()
      .then((rows) => {
        const row = rows[0];
        if (!row) throw notFound("MCP server not found");
        return row;
      });
  }

  async function deleteServer(companyId: string, id: string) {
    const existing = await getServer(companyId, id);
    if (!existing) throw notFound("MCP server not found");
    await db
      .delete(mcpServers)
      .where(and(eq(mcpServers.companyId, companyId), eq(mcpServers.id, id)));
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  async function listGrants(companyId: string, mcpServerId?: string) {
    return db
      .select()
      .from(mcpServerGrants)
      .where(
        mcpServerId
          ? and(
              eq(mcpServerGrants.companyId, companyId),
              eq(mcpServerGrants.mcpServerId, mcpServerId),
            )
          : eq(mcpServerGrants.companyId, companyId),
      )
      .orderBy(asc(mcpServerGrants.createdAt));
  }

  async function createGrant(
    companyId: string,
    input: {
      mcpServerId: string;
      principalType: string;
      principalId?: string | null;
      toolAllowlist?: string[] | null;
    },
    actor: { userId?: string | null; agentId?: string | null },
  ) {
    // Validate server belongs to company
    const server = await getServer(companyId, input.mcpServerId);
    if (!server) throw notFound("MCP server not found");

    // Validate principal constraints
    if (input.principalType === "company" && input.principalId) {
      throw unprocessable("principalId must be null when principalType is 'company'");
    }
    if (input.principalType !== "company" && !input.principalId) {
      throw unprocessable("principalId is required when principalType is not 'company'");
    }

    // Check uniqueness
    const existing = await db
      .select({ id: mcpServerGrants.id })
      .from(mcpServerGrants)
      .where(
        and(
          eq(mcpServerGrants.mcpServerId, input.mcpServerId),
          eq(mcpServerGrants.principalType, input.principalType),
          input.principalId
            ? eq(mcpServerGrants.principalId, input.principalId)
            : eq(mcpServerGrants.companyId, companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);

    // Use principalId null check to catch company-scoped duplicates
    if (existing && input.principalType === "company") {
      throw conflict("Grant already exists for this server and principal");
    }

    try {
      return await db
        .insert(mcpServerGrants)
        .values({
          companyId,
          mcpServerId: input.mcpServerId,
          principalType: input.principalType,
          principalId: input.principalId ?? null,
          toolAllowlist: input.toolAllowlist ?? null,
          createdByUserId: actor.userId ?? null,
          createdByAgentId: actor.agentId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    } catch (err) {
      // Catch unique constraint violation from DB
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("mcp_server_grants_server_principal_uq")) {
        throw conflict("Grant already exists for this server and principal");
      }
      throw err;
    }
  }

  async function deleteGrant(companyId: string, id: string) {
    const existing = await db
      .select()
      .from(mcpServerGrants)
      .where(and(eq(mcpServerGrants.companyId, companyId), eq(mcpServerGrants.id, id)))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("MCP server grant not found");
    await db
      .delete(mcpServerGrants)
      .where(and(eq(mcpServerGrants.companyId, companyId), eq(mcpServerGrants.id, id)));
  }

  // -------------------------------------------------------------------------
  // Invocations (read-only)
  // -------------------------------------------------------------------------

  async function listInvocations(
    companyId: string,
    opts: {
      runId?: string | null;
      mcpServerId?: string | null;
      limit?: number | null;
      beforeId?: string | null;
    },
  ) {
    const limit = Math.min(opts.limit ?? 100, 500);

    const conditions = [eq(mcpInvocations.companyId, companyId)];
    if (opts.runId) conditions.push(eq(mcpInvocations.runId, opts.runId));
    if (opts.mcpServerId) conditions.push(eq(mcpInvocations.mcpServerId, opts.mcpServerId));

    if (opts.beforeId) {
      // cursor: rows started before the row with this id
      const pivot = await db
        .select({ startedAt: mcpInvocations.startedAt })
        .from(mcpInvocations)
        .where(eq(mcpInvocations.id, opts.beforeId))
        .then((rows) => rows[0] ?? null);
      if (pivot) {
        conditions.push(lt(mcpInvocations.startedAt, pivot.startedAt));
      }
    }

    return db
      .select()
      .from(mcpInvocations)
      .where(and(...conditions))
      .orderBy(desc(mcpInvocations.startedAt))
      .limit(limit);
  }

  return {
    listServers,
    getServer,
    createServer,
    updateServer,
    deleteServer,
    listGrants,
    createGrant,
    deleteGrant,
    listInvocations,
  };
}
