import type { PricingModel, CostEstimate } from "@paperclipai/shared";
import { api } from "./client";

export interface CreatePricingModelInput {
  provider: string;
  model: string;
  adapterType?: string | null;
  inputCostMicrocentsPer1k: number;
  cachedInputCostMicrocentsPer1k?: number | null;
  outputCostMicrocentsPer1k: number;
  currency?: string;
  effectiveFrom?: string;
  notes?: string | null;
}

export interface UpdatePricingModelInput {
  inputCostMicrocentsPer1k?: number;
  cachedInputCostMicrocentsPer1k?: number | null;
  outputCostMicrocentsPer1k?: number;
  currency?: string;
  notes?: string | null;
}

export interface EstimatePricingInput {
  provider: string;
  model: string;
  adapterType?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const entries = Object.entries(params).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (entries.length === 0) return "";
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    search.set(key, String(value));
  }
  return `?${search.toString()}`;
}

export const pricingApi = {
  listModels: (opts?: { provider?: string; activeOnly?: boolean }) => {
    const query = buildQuery({
      provider: opts?.provider,
      activeOnly: opts?.activeOnly ? "true" : undefined,
    });
    return api.get<PricingModel[]>(`/pricing-models${query}`);
  },
  createModel: (input: CreatePricingModelInput) =>
    api.post<PricingModel>("/pricing-models", input),
  updateModel: (id: string, patch: UpdatePricingModelInput) =>
    api.patch<PricingModel>(`/pricing-models/${id}`, patch),
  deactivateModel: (id: string) =>
    api.post<PricingModel>(`/pricing-models/${id}/deactivate`, {}),
  estimate: (opts: EstimatePricingInput) => {
    const query = buildQuery({
      provider: opts.provider,
      model: opts.model,
      adapterType: opts.adapterType,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cachedInputTokens: opts.cachedInputTokens,
    });
    return api.get<CostEstimate>(`/pricing-models/estimate${query}`);
  },
};
