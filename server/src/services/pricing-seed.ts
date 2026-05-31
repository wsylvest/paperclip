import type { Db } from "@paperclipai/db";
import { pricingService } from "./pricing.js";

/**
 * Canonical list of well-known model pricing rows that Paperclip seeds on startup.
 *
 * Costs are in microcents per 1k tokens (1 microcent = 1e-6 USD).
 * Math: $X/1M tokens = $X/1000 per 1k = X * 1000 microcents per 1k.
 * Example: Sonnet input $3/1M → $0.003/1k → 3_000_000 / 1000 = 3 * 1000 = 300_000 µ¢/1k. ✓
 *
 * adapterType is null on every row — these are provider-level entries shared
 * across all adapters that use the given provider+model combination.
 */
const SEED_ROWS: Array<{
  provider: string;
  model: string;
  adapterType: null;
  inputCostMicrocentsPer1k: number;
  cachedInputCostMicrocentsPer1k: number | null;
  outputCostMicrocentsPer1k: number;
  notes: string;
}> = [
  {
    provider: "anthropic",
    model: "claude-opus-4-7",
    adapterType: null,
    inputCostMicrocentsPer1k: 1_500_000,
    cachedInputCostMicrocentsPer1k: 150_000,
    outputCostMicrocentsPer1k: 7_500_000,
    notes:
      "Anthropic public list pricing as of 2026-05-25 — https://anthropic.com/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    adapterType: null,
    inputCostMicrocentsPer1k: 300_000,
    cachedInputCostMicrocentsPer1k: 30_000,
    outputCostMicrocentsPer1k: 1_500_000,
    notes:
      "Anthropic public list pricing as of 2026-05-25 — https://anthropic.com/pricing",
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    adapterType: null,
    inputCostMicrocentsPer1k: 80_000,
    cachedInputCostMicrocentsPer1k: 8_000,
    outputCostMicrocentsPer1k: 400_000,
    notes:
      "Anthropic public list pricing as of 2026-05-25 — https://anthropic.com/pricing",
  },
  {
    provider: "openai",
    model: "gpt-5",
    adapterType: null,
    inputCostMicrocentsPer1k: 125_000,
    cachedInputCostMicrocentsPer1k: 12_500,
    outputCostMicrocentsPer1k: 1_000_000,
    notes:
      "OpenAI public list pricing as of 2026-05-25 — https://openai.com/api/pricing",
  },
  {
    provider: "openai",
    model: "gpt-5-mini",
    adapterType: null,
    inputCostMicrocentsPer1k: 25_000,
    cachedInputCostMicrocentsPer1k: 2_500,
    outputCostMicrocentsPer1k: 200_000,
    notes:
      "OpenAI public list pricing as of 2026-05-25 — https://openai.com/api/pricing",
  },
  {
    provider: "google",
    model: "gemini-2.5-pro",
    adapterType: null,
    inputCostMicrocentsPer1k: 125_000,
    cachedInputCostMicrocentsPer1k: null,
    outputCostMicrocentsPer1k: 1_000_000,
    notes:
      "Google Gemini public list pricing as of 2026-05-25 — https://ai.google.dev/pricing",
  },
  {
    provider: "google",
    model: "gemini-2.5-flash",
    adapterType: null,
    inputCostMicrocentsPer1k: 30_000,
    cachedInputCostMicrocentsPer1k: null,
    outputCostMicrocentsPer1k: 250_000,
    notes:
      "Google Gemini public list pricing as of 2026-05-25 — https://ai.google.dev/pricing",
  },
  {
    provider: "moonshot",
    model: "kimi-k2",
    adapterType: null,
    inputCostMicrocentsPer1k: 60_000,
    cachedInputCostMicrocentsPer1k: null,
    outputCostMicrocentsPer1k: 250_000,
    notes:
      "Kimi K2 pricing as of 2026-05-30 — VERIFY at https://platform.moonshot.ai/pricing. " +
      "Placeholder based on publicly available Kimi API pricing tiers. " +
      "Input: $0.06/1k tokens, Output: $0.25/1k tokens.",
  },
];

/**
 * Idempotent seed function. Inserts pricing rows for well-known models that
 * do not already have an active entry. Rows that already exist are left
 * untouched, so manual price overrides made via the UI are preserved.
 *
 * Returns the number of rows that were newly inserted.
 */
export async function seedDefaultPricingModels(db: Db): Promise<number> {
  const svc = pricingService(db);
  const systemActor = { userId: null };

  let inserted = 0;
  for (const row of SEED_ROWS) {
    const existing = await svc.getActive(row.provider, row.model, null);
    if (existing) {
      continue;
    }

    await svc.createModel(
      {
        provider: row.provider,
        model: row.model,
        adapterType: row.adapterType,
        inputCostMicrocentsPer1k: row.inputCostMicrocentsPer1k,
        cachedInputCostMicrocentsPer1k: row.cachedInputCostMicrocentsPer1k,
        outputCostMicrocentsPer1k: row.outputCostMicrocentsPer1k,
        notes: row.notes,
      },
      systemActor,
    );
    inserted++;
  }

  return inserted;
}
