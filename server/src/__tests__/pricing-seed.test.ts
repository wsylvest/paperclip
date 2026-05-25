import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — intercept pricingService so we don't need a real DB.
// ---------------------------------------------------------------------------

const mockGetActive = vi.hoisted(() => vi.fn());
const mockCreateModel = vi.hoisted(() => vi.fn());

vi.mock("../services/pricing.js", () => ({
  pricingService: () => ({
    getActive: mockGetActive,
    createModel: mockCreateModel,
    listModels: vi.fn(),
    getById: vi.fn(),
    updateModel: vi.fn(),
    deactivateModel: vi.fn(),
    estimateFromTokens: vi.fn(),
  }),
}));

// Import after mocks are registered.
const { seedDefaultPricingModels } = await import("../services/pricing-seed.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOTAL_SEED_ROWS = 7;

function makeRow(provider: string, model: string) {
  return {
    id: `id-${provider}-${model}`,
    provider,
    model,
    adapterType: null,
    inputCostMicrocentsPer1k: 100_000,
    cachedInputCostMicrocentsPer1k: null,
    outputCostMicrocentsPer1k: 500_000,
    currency: "USD",
    effectiveFrom: new Date(),
    effectiveTo: null,
    active: true,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("seedDefaultPricingModels", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: createModel returns a plausible row (provider/model extracted from args).
    mockCreateModel.mockImplementation((input: { provider: string; model: string }) =>
      Promise.resolve(makeRow(input.provider, input.model)),
    );
  });

  it("empty DB: seeds all 7 rows and returns 7", async () => {
    // Nothing exists yet.
    mockGetActive.mockResolvedValue(null);

    const count = await seedDefaultPricingModels({} as any);

    expect(count).toBe(TOTAL_SEED_ROWS);
    expect(mockCreateModel).toHaveBeenCalledTimes(TOTAL_SEED_ROWS);
  });

  it("already-seeded DB: second call inserts 0 rows (idempotent)", async () => {
    // Everything already exists.
    mockGetActive.mockImplementation((provider: string, model: string) =>
      Promise.resolve(makeRow(provider, model)),
    );

    const count = await seedDefaultPricingModels({} as any);

    expect(count).toBe(0);
    expect(mockCreateModel).not.toHaveBeenCalled();
  });

  it("partial seed (1 missing row): re-seeds only the missing row", async () => {
    // Simulate gemini-2.5-pro being the missing one.
    mockGetActive.mockImplementation((provider: string, model: string) => {
      if (provider === "google" && model === "gemini-2.5-pro") {
        return Promise.resolve(null);
      }
      return Promise.resolve(makeRow(provider, model));
    });

    const count = await seedDefaultPricingModels({} as any);

    expect(count).toBe(1);
    expect(mockCreateModel).toHaveBeenCalledOnce();
    const call = mockCreateModel.mock.calls[0][0];
    expect(call.provider).toBe("google");
    expect(call.model).toBe("gemini-2.5-pro");
  });
});
