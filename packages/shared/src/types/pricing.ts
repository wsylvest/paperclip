export interface PricingModel {
  id: string;
  provider: string;
  model: string;
  adapterType: string | null;
  inputCostMicrocentsPer1k: number;
  cachedInputCostMicrocentsPer1k: number | null;
  outputCostMicrocentsPer1k: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CostEstimate {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalCostMicrocents: number;
  totalCostCents: number;
  currency: string;
  provider: string;
  model: string;
  /**
   * Confidence in the estimate. 'historical' = derived from past runs;
   * 'heuristic' = adapter-specific guesswork; 'unknown' = best-effort defaults.
   */
  confidence: "historical" | "heuristic" | "unknown";
  /** Adapter-supplied breakdown for debugging / UI. */
  breakdown?: Array<{ label: string; tokens?: number; costMicrocents: number }>;
}
