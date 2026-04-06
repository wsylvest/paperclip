import { and, desc, eq, gte, lte, sql, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { auditEvents, auditRetentionPolicies } from "@paperclipai/db";
import type { AuditCategory, AuditSeverity } from "@paperclipai/shared";
import { notFound } from "../errors.js";

export interface AuditEventInput {
  companyId?: string | null;
  actorType: string;
  actorId: string;
  category: string;
  action: string;
  entityType: string;
  entityId: string;
  severity?: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface QueryFilters {
  category?: string;
  severity?: string;
  actorType?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

function buildFilterConditions(companyId: string, filters?: QueryFilters) {
  const conditions: ReturnType<typeof eq>[] = [eq(auditEvents.companyId, companyId)];
  if (filters?.category) conditions.push(eq(auditEvents.category, filters.category));
  if (filters?.severity) conditions.push(eq(auditEvents.severity, filters.severity));
  if (filters?.actorType) conditions.push(eq(auditEvents.actorType, filters.actorType));
  if (filters?.actorId) conditions.push(eq(auditEvents.actorId, filters.actorId));
  if (filters?.entityType) conditions.push(eq(auditEvents.entityType, filters.entityType));
  if (filters?.entityId) conditions.push(eq(auditEvents.entityId, filters.entityId));
  if (filters?.from) conditions.push(gte(auditEvents.occurredAt, filters.from));
  if (filters?.to) conditions.push(lte(auditEvents.occurredAt, filters.to));
  return conditions;
}

export function auditService(db: Db) {
  return {
    logAuditEvent: async (input: AuditEventInput) => {
      const row = await db
        .insert(auditEvents)
        .values({
          companyId: input.companyId ?? null,
          actorType: input.actorType,
          actorId: input.actorId,
          category: input.category,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          severity: input.severity ?? "info",
          previousState: input.previousState ?? null,
          newState: input.newState ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
          metadata: input.metadata ?? null,
        })
        .returning()
        .then((rows) => rows[0]);

      return row;
    },

    query: async (companyId: string, filters?: QueryFilters) => {
      const limit = filters?.limit ?? 100;
      const offset = filters?.offset ?? 0;
      const conditions = buildFilterConditions(companyId, filters);

      const [items, totalResult] = await Promise.all([
        db
          .select()
          .from(auditEvents)
          .where(and(...conditions))
          .orderBy(desc(auditEvents.occurredAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: count() })
          .from(auditEvents)
          .where(and(...conditions))
          .then((rows) => rows[0]),
      ]);

      return {
        items,
        total: Number(totalResult?.count ?? 0),
      };
    },

    exportCsv: async (companyId: string, filters?: Omit<QueryFilters, "limit" | "offset">) => {
      const conditions = buildFilterConditions(companyId, filters);

      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(...conditions))
        .orderBy(desc(auditEvents.occurredAt))
        .limit(10000);

      return rows;
    },

    cleanup: async (retentionDays?: number) => {
      const defaultRetention = retentionDays ?? 365;

      // Fetch active retention policies per company/category
      const policies = await db
        .select()
        .from(auditRetentionPolicies)
        .where(eq(auditRetentionPolicies.isActive, true));

      let totalDeleted = 0;

      // Delete events covered by specific retention policies
      for (const policy of policies) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - policy.retentionDays);

        const result = await db
          .delete(auditEvents)
          .where(
            and(
              eq(auditEvents.companyId, policy.companyId),
              eq(auditEvents.category, policy.category),
              lte(auditEvents.occurredAt, cutoff),
            ),
          )
          .returning();

        totalDeleted += result.length;
      }

      // Delete remaining events using the default retention
      const defaultCutoff = new Date();
      defaultCutoff.setDate(defaultCutoff.getDate() - defaultRetention);

      // Build conditions to exclude company/category pairs already handled
      const policyKeys = policies.map((p) => ({ companyId: p.companyId, category: p.category }));

      if (policyKeys.length > 0) {
        // Delete events not covered by any specific policy
        const excludeExpr = policyKeys.map(
          (pk) =>
            sql`NOT (${auditEvents.companyId} = ${pk.companyId} AND ${auditEvents.category} = ${pk.category})`,
        );

        const result = await db
          .delete(auditEvents)
          .where(
            and(
              lte(auditEvents.occurredAt, defaultCutoff),
              ...excludeExpr,
            ),
          )
          .returning();

        totalDeleted += result.length;
      } else {
        const result = await db
          .delete(auditEvents)
          .where(lte(auditEvents.occurredAt, defaultCutoff))
          .returning();

        totalDeleted += result.length;
      }

      return { deletedCount: totalDeleted };
    },

    complianceSummary: async (companyId: string, range?: { from?: Date; to?: Date }) => {
      const conditions: ReturnType<typeof eq>[] = [eq(auditEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(auditEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(auditEvents.occurredAt, range.to));

      const rows = await db
        .select({
          category: auditEvents.category,
          severity: auditEvents.severity,
          count: count(),
        })
        .from(auditEvents)
        .where(and(...conditions))
        .groupBy(auditEvents.category, auditEvents.severity)
        .orderBy(auditEvents.category, auditEvents.severity);

      return rows.map((row) => ({
        category: row.category as AuditCategory,
        severity: row.severity as AuditSeverity,
        count: Number(row.count),
      }));
    },

    getRetentionPolicies: async (companyId: string) => {
      const rows = await db
        .select()
        .from(auditRetentionPolicies)
        .where(eq(auditRetentionPolicies.companyId, companyId))
        .orderBy(auditRetentionPolicies.category);

      return rows;
    },

    upsertRetentionPolicy: async (
      companyId: string,
      input: { category: string; retentionDays: number; isActive: boolean },
    ) => {
      const row = await db
        .insert(auditRetentionPolicies)
        .values({
          companyId,
          category: input.category,
          retentionDays: input.retentionDays,
          isActive: input.isActive,
        })
        .onConflictDoUpdate({
          target: [auditRetentionPolicies.companyId, auditRetentionPolicies.category],
          set: {
            retentionDays: input.retentionDays,
            isActive: input.isActive,
            updatedAt: new Date(),
          },
        })
        .returning()
        .then((rows) => rows[0]);

      return row;
    },
  };
}
