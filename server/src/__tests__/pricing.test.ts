import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pricingRoutes } from "../routes/pricing.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockPricingService = vi.hoisted(() => ({
  listModels: vi.fn(),
  getById: vi.fn(),
  getActive: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deactivateModel: vi.fn(),
  estimateFromTokens: vi.fn(),
}));

vi.mock("../services/pricing.js", () => ({
  pricingService: () => mockPricingService,
}));

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function instanceAdminActor() {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [],
    memberships: [],
  };
}

function regularBoardActor() {
  return {
    type: "board",
    userId: "user-2",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [],
    memberships: [],
  };
}

function localImplicitActor() {
  return {
    type: "board",
    userId: null,
    source: "local_implicit",
    isInstanceAdmin: false,
    companyIds: [],
    memberships: [],
  };
}

function createApp(actor: Record<string, unknown> = instanceAdminActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", pricingRoutes({} as any));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL_ID = "00000000-0000-0000-0000-000000000001";

const modelFixture = {
  id: MODEL_ID,
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  adapterType: null,
  inputCostMicrocentsPer1k: 300_000,
  cachedInputCostMicrocentsPer1k: 30_000,
  outputCostMicrocentsPer1k: 1_500_000,
  currency: "USD",
  effectiveFrom: new Date().toISOString(),
  effectiveTo: null,
  active: true,
  notes: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/pricing-models", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns empty list when no models", async () => {
    mockPricingService.listModels.mockResolvedValue([]);
    const res = await request(createApp()).get("/api/pricing-models");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns list of models", async () => {
    mockPricingService.listModels.mockResolvedValue([modelFixture]);
    const res = await request(createApp()).get("/api/pricing-models");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(MODEL_ID);
  });
});

describe("POST /api/pricing-models", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates a model as instance admin", async () => {
    mockPricingService.createModel.mockResolvedValue(modelFixture);
    const res = await request(createApp())
      .post("/api/pricing-models")
      .send({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputCostMicrocentsPer1k: 300_000,
        outputCostMicrocentsPer1k: 1_500_000,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(MODEL_ID);
    expect(mockPricingService.createModel).toHaveBeenCalledOnce();
  });

  it("creates a model as local_implicit board user", async () => {
    mockPricingService.createModel.mockResolvedValue(modelFixture);
    const res = await request(createApp(localImplicitActor()))
      .post("/api/pricing-models")
      .send({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputCostMicrocentsPer1k: 300_000,
        outputCostMicrocentsPer1k: 1_500_000,
      });
    expect(res.status).toBe(201);
  });

  it("returns 403 for non-instance-admin board user", async () => {
    const res = await request(createApp(regularBoardActor()))
      .post("/api/pricing-models")
      .send({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputCostMicrocentsPer1k: 300_000,
        outputCostMicrocentsPer1k: 1_500_000,
      });
    expect(res.status).toBe(403);
    expect(mockPricingService.createModel).not.toHaveBeenCalled();
  });

  it("returns 4xx when cost is negative", async () => {
    const res = await request(createApp())
      .post("/api/pricing-models")
      .send({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputCostMicrocentsPer1k: -1,
        outputCostMicrocentsPer1k: 1_500_000,
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("PATCH /api/pricing-models/:id", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("updates a model", async () => {
    mockPricingService.getById.mockResolvedValue(modelFixture);
    const updated = { ...modelFixture, notes: "updated" };
    mockPricingService.updateModel.mockResolvedValue(updated);

    const res = await request(createApp())
      .patch(`/api/pricing-models/${MODEL_ID}`)
      .send({ notes: "updated" });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("updated");
  });

  it("returns 404 when model not found", async () => {
    mockPricingService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .patch(`/api/pricing-models/${MODEL_ID}`)
      .send({ notes: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-instance-admin board user", async () => {
    const res = await request(createApp(regularBoardActor()))
      .patch(`/api/pricing-models/${MODEL_ID}`)
      .send({ notes: "x" });
    expect(res.status).toBe(403);
  });
});

describe("POST /api/pricing-models/:id/deactivate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("deactivates a model", async () => {
    mockPricingService.getById.mockResolvedValue(modelFixture);
    const deactivated = { ...modelFixture, active: false };
    mockPricingService.deactivateModel.mockResolvedValue(deactivated);

    const res = await request(createApp()).post(`/api/pricing-models/${MODEL_ID}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it("returns 404 when model not found", async () => {
    mockPricingService.getById.mockResolvedValue(null);
    const res = await request(createApp()).post(`/api/pricing-models/${MODEL_ID}/deactivate`);
    expect(res.status).toBe(404);
  });
});

describe("pricingService.estimateFromTokens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns an estimate for a known model", async () => {
    const estimate = {
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      totalCostMicrocents: 1_050_000,
      totalCostCents: 105,
      currency: "USD",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      confidence: "heuristic",
    };
    mockPricingService.estimateFromTokens.mockResolvedValue(estimate);

    const res = await request(createApp()).get(
      "/api/pricing-models/estimate?provider=anthropic&model=claude-sonnet-4-5&inputTokens=1000&outputTokens=500&cachedInputTokens=200",
    );
    expect(res.status).toBe(200);
    expect(res.body.totalCostMicrocents).toBe(1_050_000);
  });

  it("returns 404 when no pricing row exists", async () => {
    mockPricingService.estimateFromTokens.mockResolvedValue(null);
    const res = await request(createApp()).get(
      "/api/pricing-models/estimate?provider=anthropic&model=claude-sonnet-4-5&inputTokens=1000&outputTokens=500",
    );
    expect(res.status).toBe(404);
  });
});
