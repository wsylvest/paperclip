import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { pricingApi } from "./pricing";

describe("pricingApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({});
    mockApi.patch.mockResolvedValue({});
  });

  it("listModels calls /pricing-models", async () => {
    await pricingApi.listModels();
    expect(mockApi.get).toHaveBeenCalledWith("/pricing-models");
  });

  it("listModels with provider filter includes query param", async () => {
    await pricingApi.listModels({ provider: "anthropic" });
    expect(mockApi.get).toHaveBeenCalledWith(
      expect.stringContaining("provider=anthropic"),
    );
  });

  it("listModels with activeOnly filter includes query param", async () => {
    await pricingApi.listModels({ activeOnly: true });
    expect(mockApi.get).toHaveBeenCalledWith(
      expect.stringContaining("activeOnly=true"),
    );
  });

  it("createModel POSTs to /pricing-models", async () => {
    await pricingApi.createModel({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputCostMicrocentsPer1k: 300_000,
      outputCostMicrocentsPer1k: 1_500_000,
    });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/pricing-models",
      expect.objectContaining({ provider: "anthropic", model: "claude-sonnet-4-5" }),
    );
  });

  it("updateModel PATCHes /pricing-models/:id", async () => {
    await pricingApi.updateModel("model-1", { notes: "updated" });
    expect(mockApi.patch).toHaveBeenCalledWith(
      "/pricing-models/model-1",
      { notes: "updated" },
    );
  });

  it("deactivateModel POSTs to /pricing-models/:id/deactivate", async () => {
    await pricingApi.deactivateModel("model-1");
    expect(mockApi.post).toHaveBeenCalledWith("/pricing-models/model-1/deactivate", {});
  });

  it("estimate calls /pricing-models/estimate with query params", async () => {
    await pricingApi.estimate({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 1000,
      outputTokens: 500,
    });
    const calledUrl = mockApi.get.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/pricing-models/estimate");
    expect(calledUrl).toContain("provider=anthropic");
    expect(calledUrl).toContain("model=claude-sonnet-4-5");
    expect(calledUrl).toContain("inputTokens=1000");
    expect(calledUrl).toContain("outputTokens=500");
  });
});
