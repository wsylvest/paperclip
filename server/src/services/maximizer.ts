import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, agents, costEvents } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function maximizerService(db: Db) {
  return {
    getMaximizerConfig: async (companyId: string) => {
      const [company] = await db
        .select({
          maximizerEnabled: companies.maximizerEnabled,
          maximizerConfig: companies.maximizerConfig,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) throw notFound("Company not found");
      return company;
    },

    evaluateAutoEscalation: async (companyId: string) => {
      const [company] = await db
        .select({
          budgetMonthlyCents: companies.budgetMonthlyCents,
          spentMonthlyCents: companies.spentMonthlyCents,
          maximizerEnabled: companies.maximizerEnabled,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) throw notFound("Company not found");

      // Calculate spend rate over the last 24 hours
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [spendResult] = await db
        .select({
          totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, oneDayAgo),
          ),
        );

      const currentSpendRate = Number(spendResult?.totalCents ?? 0);
      const budgetRemaining =
        company.budgetMonthlyCents - company.spentMonthlyCents;

      // Project spend: if current daily rate continues for remaining days in month
      const now = new Date();
      const daysInMonth = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
      ).getDate();
      const remainingDays = daysInMonth - now.getDate();
      const projectedSpend = currentSpendRate * remainingDays;

      const shouldEscalate =
        company.maximizerEnabled &&
        budgetRemaining > 0 &&
        projectedSpend < budgetRemaining * 0.5;

      const reason = shouldEscalate
        ? "Budget headroom available; spend rate is below 50% of remaining budget projection"
        : budgetRemaining <= 0
          ? "No budget remaining"
          : "Spend rate is on track with budget";

      return {
        shouldEscalate,
        reason,
        currentSpendRate,
        budgetRemaining,
      };
    },

    scheduleParallelExecution: async (
      companyId: string,
      issueIds: string[],
    ) => {
      // Validate company exists
      const [company] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (!company) throw notFound("Company not found");

      // Actual wakeup queueing would integrate with heartbeat service
      return {
        scheduled: issueIds.length,
        issueIds,
      };
    },

    assessAutonomyGate: async (agentId: string, action: string) => {
      const [agent] = await db
        .select({
          autonomyLevel: agents.autonomyLevel,
          permissions: agents.permissions,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (!agent) throw notFound("Agent not found");

      const highAutonomyActions = ["deploy", "merge", "delete", "spend"];
      const requiresElevated = highAutonomyActions.includes(action);

      const allowed =
        agent.autonomyLevel === "full" ||
        (agent.autonomyLevel === "elevated" && requiresElevated) ||
        (agent.autonomyLevel === "standard" && !requiresElevated);

      const reason = allowed
        ? `Action '${action}' is permitted at autonomy level '${agent.autonomyLevel}'`
        : `Action '${action}' requires higher autonomy level than '${agent.autonomyLevel}'`;

      return { allowed, reason };
    },
  };
}
