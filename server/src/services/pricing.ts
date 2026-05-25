import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pricingModels } from "@paperclipai/db";
import type { CostEstimate } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

export function pricingService(db: Db) {
  return {
    listModels: async (opts?: { provider?: string; activeOnly?: boolean }) => {
      const conditions: ReturnType<typeof eq>[] = [];
      if (opts?.provider) {
        conditions.push(eq(pricingModels.provider, opts.provider));
      }
      if (opts?.activeOnly) {
        conditions.push(eq(pricingModels.active, true));
      }

      const rows = await db
        .select()
        .from(pricingModels)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(pricingModels.provider), asc(pricingModels.model), asc(pricingModels.createdAt));

      return rows;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(pricingModels)
        .where(eq(pricingModels.id, id))
        .then((rows) => rows[0] ?? null);
      return row;
    },

    /**
     * Returns the single active pricing_models row matching (provider, model, adapterType).
     * Resolution order:
     *   1. Exact match on adapterType (non-null match)
     *   2. Row with adapterType = null (wildcard)
     * Returns null if no active row found.
     */
    getActive: async (
      provider: string,
      model: string,
      adapterType?: string | null,
    ) => {
      const rows = await db
        .select()
        .from(pricingModels)
        .where(
          and(
            eq(pricingModels.provider, provider),
            eq(pricingModels.model, model),
            eq(pricingModels.active, true),
            adapterType
              ? or(eq(pricingModels.adapterType, adapterType), isNull(pricingModels.adapterType))
              : isNull(pricingModels.adapterType),
          ),
        )
        .orderBy(asc(pricingModels.adapterType)); // null sorts first in ASC, exact match after

      if (rows.length === 0) return null;

      // Prefer exact adapterType match over wildcard null
      const exactMatch = adapterType
        ? rows.find((r) => r.adapterType === adapterType) ?? null
        : null;
      if (exactMatch) return exactMatch;

      const wildcardMatch = rows.find((r) => r.adapterType === null) ?? null;
      return wildcardMatch;
    },

    createModel: async (
      input: {
        provider: string;
        model: string;
        adapterType?: string | null;
        inputCostMicrocentsPer1k: number;
        cachedInputCostMicrocentsPer1k?: number | null;
        outputCostMicrocentsPer1k: number;
        currency?: string;
        effectiveFrom?: string;
        notes?: string | null;
      },
      _actor: { userId?: string | null },
    ) => {
      // Check uniqueness: reject if an existing active row has the same key
      const existingActive = await db
        .select()
        .from(pricingModels)
        .where(
          and(
            eq(pricingModels.provider, input.provider),
            eq(pricingModels.model, input.model),
            eq(pricingModels.active, true),
            eq(pricingModels.currency, input.currency ?? "USD"),
            input.adapterType
              ? eq(pricingModels.adapterType, input.adapterType)
              : isNull(pricingModels.adapterType),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existingActive) {
        throw unprocessable(
          `An active pricing model for provider '${input.provider}', model '${input.model}'` +
            (input.adapterType ? `, adapterType '${input.adapterType}'` : "") +
            " already exists. Deactivate it first.",
        );
      }

      const now = new Date();
      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;

      const row = await db
        .insert(pricingModels)
        .values({
          provider: input.provider,
          model: input.model,
          adapterType: input.adapterType ?? null,
          inputCostMicrocentsPer1k: input.inputCostMicrocentsPer1k,
          cachedInputCostMicrocentsPer1k: input.cachedInputCostMicrocentsPer1k ?? null,
          outputCostMicrocentsPer1k: input.outputCostMicrocentsPer1k,
          currency: input.currency ?? "USD",
          effectiveFrom,
          active: true,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      return row;
    },

    updateModel: async (
      id: string,
      patch: {
        inputCostMicrocentsPer1k?: number;
        cachedInputCostMicrocentsPer1k?: number | null;
        outputCostMicrocentsPer1k?: number;
        currency?: string;
        notes?: string | null;
      },
      _actor: { userId?: string | null },
    ) => {
      const existing = await db
        .select()
        .from(pricingModels)
        .where(eq(pricingModels.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) throw notFound("Pricing model not found");

      const now = new Date();
      const updated = await db
        .update(pricingModels)
        .set({
          ...patch,
          updatedAt: now,
        })
        .where(eq(pricingModels.id, id))
        .returning()
        .then((rows) => rows[0]);

      return updated;
    },

    /** Deactivates a row by setting effectiveTo=now and active=false. */
    deactivateModel: async (id: string, _actor: { userId?: string | null }) => {
      const existing = await db
        .select()
        .from(pricingModels)
        .where(eq(pricingModels.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) throw notFound("Pricing model not found");

      const now = new Date();
      const updated = await db
        .update(pricingModels)
        .set({
          active: false,
          effectiveTo: now,
          updatedAt: now,
        })
        .where(eq(pricingModels.id, id))
        .returning()
        .then((rows) => rows[0]);

      return updated;
    },

    /**
     * Compute a cost estimate from token counts. Returns null if no pricing row found.
     */
    estimateFromTokens: async (opts: {
      provider: string;
      model: string;
      adapterType?: string | null;
      inputTokens: number;
      cachedInputTokens?: number;
      outputTokens: number;
    }): Promise<CostEstimate | null> => {
      const pricingRow = await db
        .select()
        .from(pricingModels)
        .where(
          and(
            eq(pricingModels.provider, opts.provider),
            eq(pricingModels.model, opts.model),
            eq(pricingModels.active, true),
            opts.adapterType
              ? or(eq(pricingModels.adapterType, opts.adapterType), isNull(pricingModels.adapterType))
              : isNull(pricingModels.adapterType),
          ),
        )
        .orderBy(asc(pricingModels.adapterType))
        .then((rows) => {
          if (rows.length === 0) return null;
          // Prefer exact adapterType match
          const exact = opts.adapterType
            ? rows.find((r) => r.adapterType === opts.adapterType) ?? null
            : null;
          return exact ?? rows.find((r) => r.adapterType === null) ?? null;
        });

      if (!pricingRow) return null;

      const cachedInputTokens = opts.cachedInputTokens ?? 0;
      const regularInputTokens = opts.inputTokens - cachedInputTokens;

      const inputCost = Math.round(
        (regularInputTokens / 1000) * pricingRow.inputCostMicrocentsPer1k,
      );
      const cachedInputRate =
        pricingRow.cachedInputCostMicrocentsPer1k ?? pricingRow.inputCostMicrocentsPer1k;
      const cachedInputCost = Math.round((cachedInputTokens / 1000) * cachedInputRate);
      const outputCost = Math.round(
        (opts.outputTokens / 1000) * pricingRow.outputCostMicrocentsPer1k,
      );

      const totalCostMicrocents = inputCost + cachedInputCost + outputCost;

      return {
        inputTokens: opts.inputTokens,
        cachedInputTokens,
        outputTokens: opts.outputTokens,
        totalCostMicrocents,
        totalCostCents: totalCostMicrocents / 10_000,
        currency: pricingRow.currency,
        provider: opts.provider,
        model: opts.model,
        confidence: "heuristic",
        breakdown: [
          {
            label: "Input tokens",
            tokens: regularInputTokens,
            costMicrocents: inputCost,
          },
          {
            label: "Cached input tokens",
            tokens: cachedInputTokens,
            costMicrocents: cachedInputCost,
          },
          {
            label: "Output tokens",
            tokens: opts.outputTokens,
            costMicrocents: outputCost,
          },
        ],
      };
    },
  };
}
