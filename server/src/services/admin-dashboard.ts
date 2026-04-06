import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  auditEvents,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  instanceUserRoles,
} from "@paperclipai/db";

export function adminDashboardService(db: Db) {
  return {
    instanceOverview: async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const [
        [{ companyCount }],
        [{ userCount }],
        [{ agentCount }],
        [{ totalSpendCents }],
        [{ activeAgentCount }],
        [{ pendingApprovalCount }],
      ] = await Promise.all([
        db
          .select({ companyCount: sql<number>`count(*)::int` })
          .from(companies),
        db
          .select({ userCount: sql<number>`count(distinct ${authUsers.id})::int` })
          .from(authUsers),
        db
          .select({ agentCount: sql<number>`count(*)::int` })
          .from(agents),
        db
          .select({
            totalSpendCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          })
          .from(costEvents)
          .where(gte(costEvents.occurredAt, monthStart)),
        db
          .select({ activeAgentCount: sql<number>`count(*)::int` })
          .from(agents)
          .where(inArray(agents.status, ["idle", "running"])),
        db
          .select({ pendingApprovalCount: sql<number>`count(*)::int` })
          .from(approvals)
          .where(eq(approvals.status, "pending")),
      ]);

      return {
        companyCount,
        userCount,
        agentCount,
        totalSpendCents,
        activeAgentCount,
        pendingApprovalCount,
      };
    },

    companyHealthSummary: async () => {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      const rows = await db
        .select({
          companyId: companies.id,
          companyName: companies.name,
          companyPrefix: companies.companyPrefix,
          agentCount: sql<number>`count(distinct ${agents.id})::int`,
          activeAgentCount: sql<number>`count(distinct case when ${agents.status} in ('idle', 'running') then ${agents.id} end)::int`,
          memberCount: sql<number>`count(distinct ${companyMemberships.id})::int`,
          monthSpendCents: sql<number>`coalesce(sum(case when ${costEvents.occurredAt} >= ${monthStart} then ${costEvents.costCents} else 0 end), 0)::int`,
          lastActivityAt: sql<string | null>`max(${auditEvents.occurredAt})`,
        })
        .from(companies)
        .leftJoin(agents, eq(agents.companyId, companies.id))
        .leftJoin(companyMemberships, eq(companyMemberships.companyId, companies.id))
        .leftJoin(costEvents, eq(costEvents.companyId, companies.id))
        .leftJoin(auditEvents, eq(auditEvents.companyId, companies.id))
        .groupBy(companies.id, companies.name, companies.companyPrefix)
        .orderBy(companies.name);

      return rows.map((r) => ({
        companyId: r.companyId,
        companyName: r.companyName,
        companyPrefix: r.companyPrefix,
        agentCount: r.agentCount,
        activeAgentCount: r.activeAgentCount,
        memberCount: r.memberCount,
        monthSpendCents: r.monthSpendCents,
        lastActivityAt: r.lastActivityAt,
      }));
    },

    userManagementList: async () => {
      const users = await db
        .select({
          userId: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
          createdAt: authUsers.createdAt,
        })
        .from(authUsers)
        .orderBy(authUsers.createdAt);

      const adminRows = await db
        .select({ userId: instanceUserRoles.userId })
        .from(instanceUserRoles)
        .where(eq(instanceUserRoles.role, "instance_admin"));

      const adminSet = new Set(adminRows.map((r) => r.userId));

      const membershipRows = await db
        .select({
          principalId: companyMemberships.principalId,
          companyId: companyMemberships.companyId,
          companyName: companies.name,
          role: companyMemberships.membershipRole,
          status: companyMemberships.status,
        })
        .from(companyMemberships)
        .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
        .where(eq(companyMemberships.principalType, "user"));

      const membershipsByUser = new Map<
        string,
        { companyId: string; companyName: string; role: string; status: string }[]
      >();
      for (const m of membershipRows) {
        const list = membershipsByUser.get(m.principalId) ?? [];
        list.push({
          companyId: m.companyId,
          companyName: m.companyName,
          role: m.role,
          status: m.status,
        });
        membershipsByUser.set(m.principalId, list);
      }

      return users.map((u) => ({
        userId: u.userId,
        name: u.name,
        email: u.email,
        isInstanceAdmin: adminSet.has(u.userId),
        memberships: membershipsByUser.get(u.userId) ?? [],
        createdAt: u.createdAt,
      }));
    },
  };
}
