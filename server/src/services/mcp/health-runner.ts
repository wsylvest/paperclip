/**
 * MCP health-check runner.
 *
 * Periodically probes all registered MCP servers (across all companies) by
 * attempting to acquire a pooled client. The client-pool's 15-min reuse window
 * means most probes are cheap no-ops; the pool only re-connects when the
 * cached connection has expired.
 *
 * Status transition rules:
 *   success            → healthy,  consecutiveFails reset to 0
 *   1–2 consecutive    → degraded, consecutiveFails incremented
 *   3+  consecutive    → dead,     consecutiveFails incremented
 *
 * Activity log entries are written only on meaningful status transitions
 * (healthy → degraded/dead, or degraded/dead → healthy).
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mcpServers } from "@paperclipai/db";
import { acquireClient } from "./client-pool.js";
import { logActivity } from "../activity-log.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HealthCheckResult {
  serverId: string;
  companyId: string;
  previousStatus: string;
  newStatus: "healthy" | "degraded" | "dead" | "unknown";
  consecutiveFails: number;
  error?: string;
}

export interface HealthCycleSummary {
  scanned: number;
  results: HealthCheckResult[];
  startedAt: Date;
  finishedAt: Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function statusFromFails(fails: number): "healthy" | "degraded" | "dead" {
  if (fails <= 0) return "healthy";
  if (fails <= 2) return "degraded";
  return "dead";
}

/**
 * Returns true if the status transition is significant enough to log in the
 * activity log. We only log healthy → degraded/dead and degraded/dead → healthy.
 */
function isSignificantTransition(previous: string, next: string): boolean {
  if (previous === next) return false;
  if (next === "healthy" && (previous === "dead" || previous === "degraded")) return true;
  if (previous === "healthy" && (next === "degraded" || next === "dead")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Internal: probe a single server row
// ---------------------------------------------------------------------------

interface ServerRow {
  id: string;
  companyId: string;
  healthStatus: string;
  consecutiveFails: number;
}

async function probeRow(
  db: Db,
  row: ServerRow,
  probeTimeoutMs: number,
): Promise<HealthCheckResult> {
  const { id: serverId, companyId, healthStatus: previousStatus, consecutiveFails: prevFails } = row;

  try {
    await Promise.race([
      acquireClient(db, companyId, serverId),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          const err = new Error("probe timeout");
          err.name = "TimeoutError";
          reject(err);
        }, probeTimeoutMs),
      ),
    ]);

    return {
      serverId,
      companyId,
      previousStatus,
      newStatus: "healthy",
      consecutiveFails: 0,
    };
  } catch (err) {
    const newFails = prevFails + 1;
    const newStatus = statusFromFails(newFails);
    // Use error.name only — never error.message (may contain secrets in transport errors)
    const errorClass = err instanceof Error ? err.name : "UnknownError";
    return {
      serverId,
      companyId,
      previousStatus,
      newStatus,
      consecutiveFails: newFails,
      error: errorClass,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal: persist a single probe result and maybe write an activity log row
// ---------------------------------------------------------------------------

async function persistResult(db: Db, result: HealthCheckResult, checkedAt: Date): Promise<void> {
  await db
    .update(mcpServers)
    .set({
      healthStatus: result.newStatus,
      consecutiveFails: result.consecutiveFails,
      healthCheckedAt: checkedAt,
      updatedAt: checkedAt,
    })
    .where(
      and(
        eq(mcpServers.id, result.serverId),
        eq(mcpServers.companyId, result.companyId),
      ),
    );

  if (isSignificantTransition(result.previousStatus, result.newStatus)) {
    await logActivity(db, {
      companyId: result.companyId,
      actorType: "system",
      actorId: "mcp-health-runner",
      action: "mcp_server.health_changed",
      entityType: "mcp_server",
      entityId: result.serverId,
      details: {
        previous: result.previousStatus,
        current: result.newStatus,
        consecutiveFails: result.consecutiveFails,
      },
    }).catch(() => {
      // Non-fatal: do not let activity log errors abort health tracking
    });
  }
}

// ---------------------------------------------------------------------------
// Public: probe a single server (used by the manual probe endpoint)
// ---------------------------------------------------------------------------

/**
 * Probe one server that belongs to `companyId`. Returns null if the server
 * is not found in the given company (caller should respond with 404).
 */
export async function probeOneServer(
  db: Db,
  companyId: string,
  serverId: string,
  opts?: { probeTimeoutMs?: number },
): Promise<HealthCheckResult | null> {
  const probeTimeoutMs = opts?.probeTimeoutMs ?? 10_000;

  const rows = await db
    .select({
      id: mcpServers.id,
      companyId: mcpServers.companyId,
      healthStatus: mcpServers.healthStatus,
      consecutiveFails: mcpServers.consecutiveFails,
    })
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.companyId, companyId)));

  const row = rows[0] ?? null;
  if (!row) return null;

  const result = await probeRow(db, row, probeTimeoutMs);
  await persistResult(db, result, new Date());

  return result;
}

// ---------------------------------------------------------------------------
// Public: full health cycle across all companies
// ---------------------------------------------------------------------------

export async function runHealthCycle(
  db: Db,
  opts?: {
    /** Max servers to probe per cycle. Default 200. */
    maxServersPerCycle?: number;
    /** Soft timeout for an individual probe, ms. Default 10_000. */
    probeTimeoutMs?: number;
  },
): Promise<HealthCycleSummary> {
  const maxServersPerCycle = opts?.maxServersPerCycle ?? 200;
  const probeTimeoutMs = opts?.probeTimeoutMs ?? 10_000;
  const startedAt = new Date();

  // Select oldest-checked-first so stale servers get priority. Rows with
  // NULL healthCheckedAt sort first under ascending order in PGlite/Postgres.
  const candidates = await db
    .select({
      id: mcpServers.id,
      companyId: mcpServers.companyId,
      healthStatus: mcpServers.healthStatus,
      consecutiveFails: mcpServers.consecutiveFails,
    })
    .from(mcpServers)
    .orderBy(asc(mcpServers.healthCheckedAt))
    .limit(maxServersPerCycle);

  if (candidates.length === 0) {
    return { scanned: 0, results: [], startedAt, finishedAt: new Date() };
  }

  // Probe all candidates concurrently
  const probeSettled = await Promise.allSettled(
    candidates.map((row) => probeRow(db, row, probeTimeoutMs)),
  );

  const results: HealthCheckResult[] = probeSettled.map((settled, i) => {
    if (settled.status === "fulfilled") return settled.value;
    // probeRow should not itself throw (it catches internally), but handle
    // the unexpected case defensively.
    const row = candidates[i]!;
    const newFails = row.consecutiveFails + 1;
    return {
      serverId: row.id,
      companyId: row.companyId,
      previousStatus: row.healthStatus,
      newStatus: statusFromFails(newFails),
      consecutiveFails: newFails,
      error: settled.reason instanceof Error ? settled.reason.name : "UnknownError",
    } satisfies HealthCheckResult;
  });

  const checkedAt = new Date();

  // Persist all results; one server's DB error must not block others
  await Promise.allSettled(results.map((result) => persistResult(db, result, checkedAt)));

  return {
    scanned: candidates.length,
    results,
    startedAt,
    finishedAt: new Date(),
  };
}
