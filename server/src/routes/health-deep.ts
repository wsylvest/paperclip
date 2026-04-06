import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

export function deepHealthRoutes(db: Db) {
  const router = Router();

  router.get("/health/deep", async (_req, res) => {
    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

    // Database check
    try {
      const start = Date.now();
      await db.execute(sql`SELECT 1`);
      checks.database = { status: "ok", latencyMs: Date.now() - start };
    } catch (err) {
      checks.database = { status: "error", error: err instanceof Error ? err.message : "Unknown error" };
    }

    const overallStatus = Object.values(checks).every(c => c.status === "ok") ? "ok" : "degraded";

    res.json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  return router;
}
