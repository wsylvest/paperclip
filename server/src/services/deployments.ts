import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { deployments } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function deploymentService(db: Db) {
  return {
    create: async (companyId: string, data: {
      issueId?: string;
      agentId?: string;
      workProductId?: string;
      environment: string;
      provider?: string;
      url?: string;
      commitSha?: string;
      healthCheckUrl?: string;
    }) => {
      const [row] = await db
        .insert(deployments)
        .values({
          companyId,
          issueId: data.issueId ?? null,
          agentId: data.agentId ?? null,
          workProductId: data.workProductId ?? null,
          environment: data.environment,
          provider: data.provider ?? null,
          url: data.url ?? null,
          commitSha: data.commitSha ?? null,
          healthCheckUrl: data.healthCheckUrl ?? null,
        })
        .returning();
      return row;
    },

    getById: async (companyId: string, id: string) => {
      const [row] = await db
        .select()
        .from(deployments)
        .where(and(eq(deployments.companyId, companyId), eq(deployments.id, id)))
        .limit(1);
      if (!row) throw notFound("Deployment not found");
      return row;
    },

    updateStatus: async (
      companyId: string,
      id: string,
      status: string,
      metadata?: Record<string, unknown>,
    ) => {
      const [row] = await db
        .update(deployments)
        .set({
          status,
          ...(metadata !== undefined ? { metadata } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(deployments.companyId, companyId), eq(deployments.id, id)))
        .returning();
      if (!row) throw notFound("Deployment not found");
      return row;
    },

    checkHealth: async (companyId: string, id: string) => {
      const [row] = await db
        .update(deployments)
        .set({
          lastHealthCheckAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(deployments.companyId, companyId), eq(deployments.id, id)))
        .returning();
      if (!row) throw notFound("Deployment not found");
      return row;
    },

    rollback: async (companyId: string, id: string) => {
      const [row] = await db
        .update(deployments)
        .set({
          status: "rolled_back",
          rolledBackAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(deployments.companyId, companyId), eq(deployments.id, id)))
        .returning();
      if (!row) throw notFound("Deployment not found");
      return row;
    },

    listForIssue: async (companyId: string, issueId: string) => {
      return db
        .select()
        .from(deployments)
        .where(
          and(eq(deployments.companyId, companyId), eq(deployments.issueId, issueId)),
        )
        .orderBy(desc(deployments.createdAt));
    },

    listForCompany: async (
      companyId: string,
      filters?: { status?: string },
    ) => {
      const conditions = [eq(deployments.companyId, companyId)];
      if (filters?.status) {
        conditions.push(eq(deployments.status, filters.status));
      }
      return db
        .select()
        .from(deployments)
        .where(and(...conditions))
        .orderBy(desc(deployments.createdAt));
    },
  };
}
