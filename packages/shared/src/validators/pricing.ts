import { z } from "zod";

export const createPricingModelSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  adapterType: z.string().trim().min(1).max(100).optional().nullable(),
  inputCostMicrocentsPer1k: z.number().int().min(0),
  cachedInputCostMicrocentsPer1k: z.number().int().min(0).optional().nullable(),
  outputCostMicrocentsPer1k: z.number().int().min(0),
  currency: z.string().trim().min(1).max(10).default("USD"),
  effectiveFrom: z.string().datetime().optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export type CreatePricingModel = z.infer<typeof createPricingModelSchema>;

export const updatePricingModelSchema = z.object({
  inputCostMicrocentsPer1k: z.number().int().min(0).optional(),
  cachedInputCostMicrocentsPer1k: z.number().int().min(0).optional().nullable(),
  outputCostMicrocentsPer1k: z.number().int().min(0).optional(),
  currency: z.string().trim().min(1).max(10).optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export type UpdatePricingModel = z.infer<typeof updatePricingModelSchema>;
