import { describe, expect, it, vi } from "vitest";
import { estimateCost } from "./estimate-cost.js";
import type { AdapterEstimateContext, CostEstimate } from "@paperclipai/adapter-utils";

function makeEstimate(overrides: Partial<CostEstimate> = {}): CostEstimate {
  return {
    inputTokens: 2500,
    cachedInputTokens: 0,
    outputTokens: 750,
    totalCostMicrocents: 1_875_000,
    totalCostCents: 187.5,
    currency: "USD",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    confidence: "heuristic",
    ...overrides,
  };
}

function makeCtx(
  text: string,
  adapterConfig: Record<string, unknown> = {},
  estimateFromTokensImpl: () => Promise<CostEstimate | null> = () =>
    Promise.resolve(makeEstimate()),
): AdapterEstimateContext {
  return {
    agent: {
      id: "agent-1",
      companyId: "company-1",
      adapterType: "claude_local",
      adapterConfig,
    },
    taskInput: { text },
    pricing: {
      estimateFromTokens: vi.fn().mockImplementation(estimateFromTokensImpl),
    },
  };
}

describe("claude-local estimateCost", () => {
  it("uses default model when adapterConfig has no model, calls estimateFromTokens with inputTokens in range [2000,3000]", async () => {
    const prompt = "a".repeat(4000);
    const ctx = makeCtx(prompt);

    const result = await estimateCost(ctx);

    expect(result).not.toBeNull();
    expect(ctx.pricing.estimateFromTokens).toHaveBeenCalledOnce();

    const call = vi.mocked(ctx.pricing.estimateFromTokens).mock.calls[0][0];
    expect(call.provider).toBe("anthropic");
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.adapterType).toBe("claude_local");
    // 4000/4 = 1000 text tokens + 1500 overhead = 2500 — within [2000, 3000]
    expect(call.inputTokens).toBeGreaterThanOrEqual(2000);
    expect(call.inputTokens).toBeLessThanOrEqual(3000);
  });

  it("uses the model from adapterConfig when provided", async () => {
    const prompt = "a".repeat(4000);
    const ctx = makeCtx(prompt, { model: "claude-opus-4-7" });

    await estimateCost(ctx);

    const call = vi.mocked(ctx.pricing.estimateFromTokens).mock.calls[0][0];
    expect(call.model).toBe("claude-opus-4-7");
    expect(call.provider).toBe("anthropic");
  });

  it("returns null when estimateFromTokens returns null", async () => {
    const prompt = "a".repeat(4000);
    const ctx = makeCtx(prompt, {}, () => Promise.resolve(null));

    const result = await estimateCost(ctx);

    expect(result).toBeNull();
    expect(ctx.pricing.estimateFromTokens).toHaveBeenCalledOnce();
  });
});
