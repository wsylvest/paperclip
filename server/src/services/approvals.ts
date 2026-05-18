import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals, mcpInvocations } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      if (applied && updated.type === "mcp_tool_call") {
        const payload = updated.payload as Record<string, unknown>;
        const mcpInvocationId = typeof payload.mcpInvocationId === "string" ? payload.mcpInvocationId : null;
        const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
        const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (mcpInvocationId) {
          await db
            .update(mcpInvocations)
            .set({ status: "approved_pending_retry", finishedAt: now })
            .where(eq(mcpInvocations.id, mcpInvocationId));
        }
        void logActivity(db, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: decidedByUserId,
          agentId: agentId ?? undefined,
          action: "mcp_tool_call.approved",
          entityType: "approval",
          entityId: id,
          details: { mcpInvocationId, toolName, agentId },
        }).catch(() => {});
        publishLiveEvent({
          companyId: updated.companyId,
          type: "mcp.approval_resolved",
          payload: {
            approvalId: id,
            decision: "approved",
            mcpInvocationId,
            toolName,
            agentId,
          },
        });
      }

      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      if (applied && updated.type === "mcp_tool_call") {
        const payload = updated.payload as Record<string, unknown>;
        const mcpInvocationId = typeof payload.mcpInvocationId === "string" ? payload.mcpInvocationId : null;
        const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
        const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (mcpInvocationId) {
          await db
            .update(mcpInvocations)
            .set({ status: "denied", errorClass: "approval_rejected", finishedAt: new Date() })
            .where(eq(mcpInvocations.id, mcpInvocationId));
        }
        void logActivity(db, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: decidedByUserId,
          agentId: agentId ?? undefined,
          action: "mcp_tool_call.denied",
          entityType: "approval",
          entityId: id,
          details: { mcpInvocationId, toolName, agentId },
        }).catch(() => {});
        publishLiveEvent({
          companyId: updated.companyId,
          type: "mcp.approval_resolved",
          payload: {
            approvalId: id,
            decision: "rejected",
            mcpInvocationId,
            toolName,
            agentId,
          },
        });
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);

      if (updated && updated.type === "mcp_tool_call") {
        const payload = updated.payload as Record<string, unknown>;
        const mcpInvocationId = typeof payload.mcpInvocationId === "string" ? payload.mcpInvocationId : null;
        const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
        const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
        publishLiveEvent({
          companyId: updated.companyId,
          type: "mcp.approval_resolved",
          payload: {
            approvalId: id,
            decision: "revision_requested",
            note: decisionNote ?? null,
            mcpInvocationId,
            toolName,
            agentId,
          },
        });
      }

      return updated;
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },

    /**
     * Auto-expire pending approvals older than `maxAgeMs`. Marks them as
     * rejected with a `system:auto-expire` decider so they roll through the
     * same downstream handling as a manual rejection.
     *
     * For mcp_tool_call approvals we also link-update the corresponding
     * mcp_invocations row to status='denied' with error_class='approval_expired'
     * and publish a `mcp.approval_resolved` live event with decision='expired'
     * so any agent CLI listening for resume signals notices the deadend.
     *
     * Safe to call concurrently — uses a WHERE filter on status='pending'
     * so already-resolved approvals are skipped.
     */
    expireStaleApprovals: async (maxAgeMs: number) => {
      const cutoff = new Date(Date.now() - maxAgeMs);
      const stale = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.status, "pending"), lt(approvals.createdAt, cutoff)));

      if (stale.length === 0) {
        return { expired: 0, mcpToolCallsDenied: 0 };
      }

      const now = new Date();
      let mcpToolCallsDenied = 0;

      // Process serially so a single failure doesn't bring down the whole batch.
      for (const row of stale) {
        try {
          await db
            .update(approvals)
            .set({
              status: "rejected",
              decidedByUserId: "system:auto-expire",
              decisionNote: `Auto-expired after ${Math.round(maxAgeMs / 1000)}s pending`,
              decidedAt: now,
              updatedAt: now,
            })
            .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")));

          if (row.type === "mcp_tool_call") {
            const payload = (row.payload ?? {}) as Record<string, unknown>;
            const mcpInvocationId =
              typeof payload.mcpInvocationId === "string" ? payload.mcpInvocationId : null;
            const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
            const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
            if (mcpInvocationId) {
              await db
                .update(mcpInvocations)
                .set({
                  status: "denied",
                  errorClass: "approval_expired",
                  finishedAt: now,
                })
                .where(eq(mcpInvocations.id, mcpInvocationId));
              mcpToolCallsDenied += 1;
            }
            void logActivity(db, {
              companyId: row.companyId,
              actorType: "user",
              actorId: "system:auto-expire",
              agentId: agentId ?? undefined,
              action: "mcp_tool_call.denied",
              entityType: "approval",
              entityId: row.id,
              details: { mcpInvocationId, toolName, agentId, reason: "auto_expired" },
            }).catch(() => {});
            publishLiveEvent({
              companyId: row.companyId,
              type: "mcp.approval_resolved",
              payload: {
                approvalId: row.id,
                decision: "rejected",
                mcpInvocationId,
                toolName,
                agentId,
                note: "auto_expired",
              },
            });
          }
        } catch {
          // Swallow per-row failures; the next cycle picks them up.
        }
      }

      return { expired: stale.length, mcpToolCallsDenied };
    },
  };
}
