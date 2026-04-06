import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, auditEvents, costEvents, issues, reportSnapshots } from "@paperclipai/db";

export function reportService(db: Db) {
  return {
    costTimeSeries: async (
      companyId: string,
      from: Date,
      to: Date,
      granularity: "daily" | "weekly" | "monthly",
    ) => {
      const truncUnit = granularity === "daily" ? "day" : granularity === "weekly" ? "week" : "month";
      return db
        .select({
          period: sql<string>`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${costEvents.occurredAt})::text`.as("period"),
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`.as("cost_cents"),
          eventCount: sql<number>`count(*)::int`.as("event_count"),
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, from),
            lte(costEvents.occurredAt, to),
          ),
        )
        .groupBy(sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${costEvents.occurredAt})`)
        .orderBy(sql`date_trunc(${sql.raw(`'${truncUnit}'`)}, ${costEvents.occurredAt})`);
    },

    agentPerformance: async (companyId: string, from?: Date, to?: Date) => {
      const conditions: ReturnType<typeof eq>[] = [eq(agents.companyId, companyId)];

      const issueConditions: ReturnType<typeof eq>[] = [eq(issues.status, "done")];
      if (from) issueConditions.push(gte(issues.completedAt, from));
      if (to) issueConditions.push(lte(issues.completedAt, to));

      const costConditions: ReturnType<typeof eq>[] = [];
      if (from) costConditions.push(gte(costEvents.occurredAt, from));
      if (to) costConditions.push(lte(costEvents.occurredAt, to));

      const issueStats = db
        .select({
          agentId: issues.assigneeAgentId,
          tasksCompleted: sql<number>`count(*)::int`.as("tasks_completed"),
          avgResolutionHours: sql<number>`coalesce(avg(extract(epoch from (${issues.completedAt} - ${issues.startedAt})) / 3600), 0)::float`.as("avg_resolution_hours"),
          totalTasks: sql<number>`count(*)::int`.as("total_tasks"),
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), ...issueConditions))
        .groupBy(issues.assigneeAgentId)
        .as("issue_stats");

      const costStats = db
        .select({
          agentId: costEvents.agentId,
          totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`.as("total_cost_cents"),
        })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), ...costConditions))
        .groupBy(costEvents.agentId)
        .as("cost_stats");

      const allTaskStats = db
        .select({
          agentId: issues.assigneeAgentId,
          totalAll: sql<number>`count(*)::int`.as("total_all"),
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            ...(from ? [gte(issues.createdAt, from)] : []),
            ...(to ? [lte(issues.createdAt, to)] : []),
          ),
        )
        .groupBy(issues.assigneeAgentId)
        .as("all_task_stats");

      return db
        .select({
          agentId: agents.id,
          agentName: agents.name,
          tasksCompleted: sql<number>`coalesce(${issueStats.tasksCompleted}, 0)::int`,
          avgResolutionHours: sql<number>`coalesce(${issueStats.avgResolutionHours}, 0)::float`,
          totalCostCents: sql<number>`coalesce(${costStats.totalCostCents}, 0)::int`,
          successRate: sql<number>`case when coalesce(${allTaskStats.totalAll}, 0) = 0 then 0 else round(coalesce(${issueStats.tasksCompleted}, 0)::numeric / ${allTaskStats.totalAll} * 100, 2) end::float`,
        })
        .from(agents)
        .leftJoin(issueStats, eq(agents.id, issueStats.agentId))
        .leftJoin(costStats, eq(agents.id, costStats.agentId))
        .leftJoin(allTaskStats, eq(agents.id, allTaskStats.agentId))
        .where(and(...conditions));
    },

    userActivity: async (companyId: string, from?: Date, to?: Date) => {
      const conditions: ReturnType<typeof eq>[] = [
        eq(auditEvents.companyId, companyId),
        eq(auditEvents.actorType, "user"),
      ];
      if (from) conditions.push(gte(auditEvents.occurredAt, from));
      if (to) conditions.push(lte(auditEvents.occurredAt, to));

      return db
        .select({
          userId: auditEvents.actorId,
          actionCount: sql<number>`count(*)::int`,
          lastActiveAt: sql<string>`max(${auditEvents.occurredAt})::text`,
          topActions: sql<string[]>`(array_agg(distinct ${auditEvents.action}))[1:5]`,
        })
        .from(auditEvents)
        .where(and(...conditions))
        .groupBy(auditEvents.actorId)
        .orderBy(desc(sql`count(*)`));
    },

    generateSnapshot: async (
      companyId: string,
      reportType: string,
      periodStart: Date,
      periodEnd: Date,
    ) => {
      let data: Record<string, unknown>;

      switch (reportType) {
        case "cost": {
          const costRows = await db
            .select({
              totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
              eventCount: sql<number>`count(*)::int`,
              totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
              totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, periodStart),
                lte(costEvents.occurredAt, periodEnd),
              ),
            );
          data = costRows[0] as unknown as Record<string, unknown>;
          break;
        }
        case "issues": {
          const issueRows = await db
            .select({
              total: sql<number>`count(*)::int`,
              completed: sql<number>`count(*) filter (where ${issues.status} = 'done')::int`,
              avgResolutionHours: sql<number>`coalesce(avg(extract(epoch from (${issues.completedAt} - ${issues.startedAt})) / 3600) filter (where ${issues.status} = 'done'), 0)::float`,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                gte(issues.createdAt, periodStart),
                lte(issues.createdAt, periodEnd),
              ),
            );
          data = issueRows[0] as unknown as Record<string, unknown>;
          break;
        }
        default:
          data = {};
      }

      const [snapshot] = await db
        .insert(reportSnapshots)
        .values({
          companyId,
          reportType,
          periodStart,
          periodEnd,
          data,
        })
        .returning();

      return snapshot;
    },

    exportCsv: async (
      companyId: string,
      reportType: string,
      from: Date,
      to: Date,
    ) => {
      switch (reportType) {
        case "cost":
          return db
            .select({
              id: costEvents.id,
              agentId: costEvents.agentId,
              provider: costEvents.provider,
              model: costEvents.model,
              costCents: costEvents.costCents,
              inputTokens: costEvents.inputTokens,
              outputTokens: costEvents.outputTokens,
              occurredAt: costEvents.occurredAt,
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, from),
                lte(costEvents.occurredAt, to),
              ),
            )
            .orderBy(costEvents.occurredAt);
        case "issues":
          return db
            .select({
              id: issues.id,
              title: issues.title,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
              startedAt: issues.startedAt,
              completedAt: issues.completedAt,
              createdAt: issues.createdAt,
            })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, companyId),
                gte(issues.createdAt, from),
                lte(issues.createdAt, to),
              ),
            )
            .orderBy(issues.createdAt);
        case "audit":
          return db
            .select({
              id: auditEvents.id,
              actorType: auditEvents.actorType,
              actorId: auditEvents.actorId,
              category: auditEvents.category,
              action: auditEvents.action,
              occurredAt: auditEvents.occurredAt,
            })
            .from(auditEvents)
            .where(
              and(
                eq(auditEvents.companyId, companyId),
                gte(auditEvents.occurredAt, from),
                lte(auditEvents.occurredAt, to),
              ),
            )
            .orderBy(auditEvents.occurredAt);
        default:
          return [];
      }
    },
  };
}
