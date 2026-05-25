import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
}));

const mockGetServerAdapter = vi.hoisted(() => vi.fn());
const mockPricingEstimate = vi.hoisted(() => vi.fn());
const mockParseObject = vi.hoisted(() => vi.fn());

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: (...args: unknown[]) => mockGetServerAdapter(...args),
}));

vi.mock("../adapters/utils.js", () => ({
  parseObject: (...args: unknown[]) => mockParseObject(...args),
}));

vi.mock("../services/pricing.js", () => ({
  pricingService: () => ({
    estimateFromTokens: (...args: unknown[]) => mockPricingEstimate(...args),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    status: "queued",
    preRunApprovalId: null,
    contextSnapshot: {},
    ...overrides,
  };
}

function makeEstimate(totalCostMicrocents = 100_000) {
  return {
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 500,
    totalCostMicrocents,
    totalCostCents: totalCostMicrocents / 10_000,
    currency: "USD",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    confidence: "heuristic" as const,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pricingGateService.check", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env["PAPERCLIP_PRERUN_COST_GATE_ENABLED"];
    delete process.env["PAPERCLIP_PRERUN_APPROVAL_THRESHOLD_MICROCENTS"];
    mockParseObject.mockReturnValue({});
  });

  it("gate disabled (env flag off) always returns proceed", async () => {
    // PAPERCLIP_PRERUN_COST_GATE_ENABLED not set → default false
    const { pricingGateService } = await import("../services/pricing-gate.js");
    const result = await pricingGateService(mockDb as any).check(makeRun() as any);
    expect(result.action).toBe("proceed");
    expect(result.reason).toBe("gate_disabled");
  });

  it("gate enabled + adapter returns null → skip", async () => {
    process.env["PAPERCLIP_PRERUN_COST_GATE_ENABLED"] = "true";
    mockGetServerAdapter.mockReturnValue({ estimateCost: vi.fn().mockResolvedValue(null) });
    // db.select chain for agents
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([{ id: "agent-1", companyId: "company-1", adapterType: "claude_local", adapterConfig: {}, budgetMonthlyCents: 0 }]))),
    };
    mockDb.select.mockReturnValue(selectChain);

    const { pricingGateService } = await import("../services/pricing-gate.js");
    const result = await pricingGateService(mockDb as any).check(makeRun() as any);
    expect(result.action).toBe("skip");
    expect(result.reason).toBe("no_estimate");
  });

  it("gate enabled + estimate below threshold → proceed", async () => {
    process.env["PAPERCLIP_PRERUN_COST_GATE_ENABLED"] = "true";
    process.env["PAPERCLIP_PRERUN_APPROVAL_THRESHOLD_MICROCENTS"] = "1000000"; // 1 dollar
    mockGetServerAdapter.mockReturnValue({
      estimateCost: vi.fn().mockResolvedValue(makeEstimate(100_000)), // 1 cent < 1 dollar
    });
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([{ id: "agent-1", companyId: "company-1", adapterType: "claude_local", adapterConfig: {}, budgetMonthlyCents: 0 }]))),
    };
    mockDb.select.mockReturnValue(selectChain);

    const { pricingGateService } = await import("../services/pricing-gate.js");
    const result = await pricingGateService(mockDb as any).check(makeRun() as any);
    expect(result.action).toBe("proceed");
    expect(result.reason).toBe("below_threshold");
  });

  it("gate enabled + estimate above threshold + no existing approval → block + approval created", async () => {
    process.env["PAPERCLIP_PRERUN_COST_GATE_ENABLED"] = "true";
    process.env["PAPERCLIP_PRERUN_APPROVAL_THRESHOLD_MICROCENTS"] = "100"; // tiny threshold
    const estimate = makeEstimate(1_000_000); // well above
    mockGetServerAdapter.mockReturnValue({
      estimateCost: vi.fn().mockResolvedValue(estimate),
    });
    // agents select
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([{ id: "agent-1", companyId: "company-1", adapterType: "claude_local", adapterConfig: {}, budgetMonthlyCents: 0 }]))),
    };
    mockDb.select.mockReturnValue(selectChain);
    // insert approval
    const insertChain = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([{ id: "approval-1" }]))),
    };
    mockDb.insert.mockReturnValue(insertChain);
    // update heartbeatRuns
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    mockDb.update.mockReturnValue(updateChain);

    const { pricingGateService } = await import("../services/pricing-gate.js");
    const result = await pricingGateService(mockDb as any).check(makeRun() as any);
    expect(result.action).toBe("block");
    expect(result.approvalId).toBe("approval-1");
    expect(result.reason).toBe("above_threshold");
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("gate enabled + existing pending approval → block, no new approval", async () => {
    process.env["PAPERCLIP_PRERUN_COST_GATE_ENABLED"] = "true";
    // Run already has a preRunApprovalId
    const run = makeRun({ preRunApprovalId: "approval-existing" });
    // select approvals
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([{ id: "approval-existing", status: "pending" }]))),
    };
    mockDb.select.mockReturnValue(selectChain);

    const { pricingGateService } = await import("../services/pricing-gate.js");
    const result = await pricingGateService(mockDb as any).check(run as any);
    expect(result.action).toBe("block");
    expect(result.reason).toBe("pending");
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it("gate enabled + existing approved approval → proceed", async () => {
    process.env["PAPERCLIP_PRERUN_COST_GATE_ENABLED"] = "true";
    const run = makeRun({ preRunApprovalId: "approval-approved" });
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([{ id: "approval-approved", status: "approved" }]))),
    };
    mockDb.select.mockReturnValue(selectChain);

    const { pricingGateService } = await import("../services/pricing-gate.js");
    const result = await pricingGateService(mockDb as any).check(run as any);
    expect(result.action).toBe("proceed");
    expect(result.approvalId).toBe("approval-approved");
  });

  it("gate enabled + existing rejected approval → run is cancelled", async () => {
    process.env["PAPERCLIP_PRERUN_COST_GATE_ENABLED"] = "true";
    const run = makeRun({ preRunApprovalId: "approval-rejected" });
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([{ id: "approval-rejected", status: "rejected" }]))),
    };
    mockDb.select.mockReturnValue(selectChain);
    const updateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    mockDb.update.mockReturnValue(updateChain);

    const { pricingGateService } = await import("../services/pricing-gate.js");
    const result = await pricingGateService(mockDb as any).check(run as any);
    expect(result.action).toBe("block");
    expect(result.reason).toBe("rejected");
    expect(mockDb.update).toHaveBeenCalled();
  });
});
