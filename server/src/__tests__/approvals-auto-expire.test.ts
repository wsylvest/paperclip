import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

vi.mock("../services/agents.js", () => ({ agentService: vi.fn(() => ({})) }));
vi.mock("../services/hire-hook.js", () => ({ notifyHireApproved: vi.fn() }));
vi.mock("../services/budgets.js", () => ({
  budgetService: vi.fn(() => ({})),
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  })),
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

const publishLiveEventMock = vi.hoisted(() => vi.fn());
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));

type ApprovalRow = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  createdAt: Date;
};

/**
 * Minimal DB stub that returns canned rows for the initial select and
 * records every update call so we can assert what was written.
 */
function createDb(staleApprovals: ApprovalRow[]) {
  const updates: Array<{ table: string; set: Record<string, unknown> }> = [];

  const selectWhere = vi.fn().mockResolvedValue(staleApprovals);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const update = vi.fn((tableRef: unknown) => {
    const tableName =
      typeof tableRef === "object" && tableRef !== null
        ? // drizzle table objects expose Symbol(drizzle:Name)
          // but for the stub we just use the constructor name
          ((tableRef as { _: { name?: string } })._?.name ??
            (Object.getOwnPropertySymbols(tableRef).map((s) =>
              (tableRef as Record<symbol, unknown>)[s],
            ).find((v) => typeof v === "string") as string | undefined) ??
            "unknown")
        : "unknown";
    return {
      set: (values: Record<string, unknown>) => {
        return {
          where: () => {
            updates.push({ table: tableName, set: values });
            return Promise.resolve();
          },
        };
      },
    };
  });

  return { db: { select, update } as unknown, updates };
}

describe("approvalService.expireStaleApprovals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns {expired: 0, mcpToolCallsDenied: 0} when no rows are stale", async () => {
    const { db } = createDb([]);
    const svc = approvalService(db as never);
    const result = await svc.expireStaleApprovals(60_000);
    expect(result.expired).toBe(0);
    expect(result.mcpToolCallsDenied).toBe(0);
  });

  it("marks stale non-mcp approvals as rejected with system:auto-expire decider", async () => {
    const stale: ApprovalRow[] = [
      {
        id: "ap-1",
        companyId: "co-1",
        type: "hire_agent",
        status: "pending",
        payload: { agentId: "a-1" },
        createdAt: new Date(Date.now() - 86_400_000),
      },
    ];
    const { db, updates } = createDb(stale);
    const svc = approvalService(db as never);
    const result = await svc.expireStaleApprovals(60_000);

    expect(result.expired).toBe(1);
    expect(result.mcpToolCallsDenied).toBe(0);
    // First update should be on approvals; status='rejected', decider='system:auto-expire'
    const approvalUpdate = updates[0];
    expect(approvalUpdate.set.status).toBe("rejected");
    expect(approvalUpdate.set.decidedByUserId).toBe("system:auto-expire");
    expect(typeof approvalUpdate.set.decisionNote).toBe("string");
    expect(approvalUpdate.set.decisionNote).toMatch(/Auto-expired/);
  });

  it("for mcp_tool_call: also denies the mcp_invocations row and fires live event", async () => {
    const stale: ApprovalRow[] = [
      {
        id: "ap-1",
        companyId: "co-1",
        type: "mcp_tool_call",
        status: "pending",
        payload: {
          mcpInvocationId: "inv-1",
          toolName: "search",
          agentId: "agent-1",
        },
        createdAt: new Date(Date.now() - 86_400_000),
      },
    ];
    const { db, updates } = createDb(stale);
    const svc = approvalService(db as never);
    const result = await svc.expireStaleApprovals(60_000);

    expect(result.expired).toBe(1);
    expect(result.mcpToolCallsDenied).toBe(1);

    // Should issue both an approvals update AND an mcp_invocations update
    expect(updates.length).toBe(2);
    const invUpdate = updates.find((u) => (u.set as Record<string, unknown>).status === "denied");
    expect(invUpdate).toBeDefined();
    expect(invUpdate!.set.errorClass).toBe("approval_expired");

    // Live event fired with decision='rejected' and note='auto_expired'
    expect(publishLiveEventMock).toHaveBeenCalledTimes(1);
    const liveEventArg = publishLiveEventMock.mock.calls[0][0] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(liveEventArg.type).toBe("mcp.approval_resolved");
    expect(liveEventArg.payload.decision).toBe("rejected");
    expect(liveEventArg.payload.note).toBe("auto_expired");
    expect(liveEventArg.payload.mcpInvocationId).toBe("inv-1");
  });

  it("processes mixed batch: 2 stale (1 mcp + 1 hire) → 2 expired, 1 mcp denied", async () => {
    const stale: ApprovalRow[] = [
      {
        id: "ap-1",
        companyId: "co-1",
        type: "mcp_tool_call",
        status: "pending",
        payload: { mcpInvocationId: "inv-1", toolName: "t", agentId: "a-1" },
        createdAt: new Date(Date.now() - 86_400_000),
      },
      {
        id: "ap-2",
        companyId: "co-1",
        type: "hire_agent",
        status: "pending",
        payload: { agentId: "a-2" },
        createdAt: new Date(Date.now() - 86_400_000),
      },
    ];
    const { db } = createDb(stale);
    const svc = approvalService(db as never);
    const result = await svc.expireStaleApprovals(60_000);

    expect(result.expired).toBe(2);
    expect(result.mcpToolCallsDenied).toBe(1);
  });
});
