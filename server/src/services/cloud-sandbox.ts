import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { cloudSandboxes } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function cloudSandboxService(db: Db) {
  return {
    provision: async (
      companyId: string,
      config: {
        agentId?: string;
        provider: string;
        templateId?: string;
        region?: string;
        cpuCores?: number;
        memoryMb?: number;
        timeoutSeconds?: number;
      },
    ) => {
      const timeoutSeconds = config.timeoutSeconds ?? 3600;
      const [row] = await db
        .insert(cloudSandboxes)
        .values({
          companyId,
          agentId: config.agentId ?? null,
          provider: config.provider,
          status: "provisioning",
          templateId: config.templateId ?? null,
          region: config.region ?? null,
          cpuCores: config.cpuCores ?? null,
          memoryMb: config.memoryMb ?? null,
          timeoutSeconds,
          expiresAt: new Date(Date.now() + timeoutSeconds * 1000),
        })
        .returning();
      return row;
    },

    terminate: async (companyId: string, sandboxId: string) => {
      const [row] = await db
        .update(cloudSandboxes)
        .set({
          status: "terminated",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(cloudSandboxes.companyId, companyId),
            eq(cloudSandboxes.id, sandboxId),
          ),
        )
        .returning();
      if (!row) throw notFound("Cloud sandbox not found");
      return row;
    },

    extend: async (
      companyId: string,
      sandboxId: string,
      additionalSeconds: number,
    ) => {
      const [row] = await db
        .update(cloudSandboxes)
        .set({
          expiresAt: sql`coalesce(${cloudSandboxes.expiresAt}, now()) + interval '1 second' * ${additionalSeconds}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(cloudSandboxes.companyId, companyId),
            eq(cloudSandboxes.id, sandboxId),
          ),
        )
        .returning();
      if (!row) throw notFound("Cloud sandbox not found");
      return row;
    },

    pollStatus: async (companyId: string, sandboxId: string) => {
      const [row] = await db
        .select()
        .from(cloudSandboxes)
        .where(
          and(
            eq(cloudSandboxes.companyId, companyId),
            eq(cloudSandboxes.id, sandboxId),
          ),
        )
        .limit(1);
      if (!row) throw notFound("Cloud sandbox not found");
      return row;
    },

    listActive: async (companyId: string) => {
      return db
        .select()
        .from(cloudSandboxes)
        .where(
          and(
            eq(cloudSandboxes.companyId, companyId),
            inArray(cloudSandboxes.status, ["provisioning", "running", "paused"]),
          ),
        )
        .orderBy(desc(cloudSandboxes.createdAt));
    },
  };
}
