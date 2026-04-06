import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceRegistry } from "@paperclipai/db";

export function instanceRegistryService(db: Db) {
  return {
    register: async (
      instanceId: string,
      metadata?: { hostname?: string; port?: number; version?: string; extra?: Record<string, unknown> },
    ) => {
      const now = new Date();
      const [row] = await db
        .insert(instanceRegistry)
        .values({
          instanceId,
          hostname: metadata?.hostname ?? null,
          port: metadata?.port ?? null,
          version: metadata?.version ?? null,
          status: "active",
          lastHeartbeatAt: now,
          metadata: metadata?.extra ?? null,
        })
        .onConflictDoUpdate({
          target: instanceRegistry.instanceId,
          set: {
            hostname: metadata?.hostname ?? null,
            port: metadata?.port ?? null,
            version: metadata?.version ?? null,
            status: "active",
            lastHeartbeatAt: now,
            metadata: metadata?.extra ?? null,
          },
        })
        .returning();
      return row;
    },

    heartbeat: async (instanceId: string) => {
      const [row] = await db
        .update(instanceRegistry)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(instanceRegistry.instanceId, instanceId))
        .returning();
      return row ?? null;
    },

    listActive: async () => {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      return db
        .select()
        .from(instanceRegistry)
        .where(
          and(
            eq(instanceRegistry.status, "active"),
            sql`${instanceRegistry.lastHeartbeatAt} > ${twoMinutesAgo}`,
          ),
        );
    },

    deregister: async (instanceId: string) => {
      const [row] = await db
        .update(instanceRegistry)
        .set({ status: "stopped" })
        .where(eq(instanceRegistry.instanceId, instanceId))
        .returning();
      return row ?? null;
    },
  };
}
