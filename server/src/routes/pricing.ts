import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createPricingModelSchema, updatePricingModelSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard } from "./authz.js";
import { pricingService } from "../services/pricing.js";
import { forbidden, notFound } from "../errors.js";

function assertInstanceAdmin(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
  if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    throw forbidden("Instance admin access required");
  }
}

export function pricingRoutes(db: Db) {
  const router = Router();
  const svc = pricingService(db);

  router.get("/pricing-models", async (req, res) => {
    assertBoard(req);
    const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
    const activeOnly = req.query.activeOnly === "true";
    const models = await svc.listModels({ provider, activeOnly });
    res.json(models);
  });

  router.get("/pricing-models/estimate", async (req, res) => {
    assertBoard(req);
    const { provider, model, adapterType, inputTokens, outputTokens, cachedInputTokens } =
      req.query as Record<string, string | undefined>;

    if (!provider || !model) {
      res.status(400).json({ error: "provider and model are required" });
      return;
    }

    const estimate = await svc.estimateFromTokens({
      provider,
      model,
      adapterType: adapterType ?? null,
      inputTokens: parseInt(inputTokens ?? "0", 10) || 0,
      cachedInputTokens: parseInt(cachedInputTokens ?? "0", 10) || 0,
      outputTokens: parseInt(outputTokens ?? "0", 10) || 0,
    });

    if (!estimate) {
      res.status(404).json({ error: "No active pricing model found for the given provider/model" });
      return;
    }
    res.json(estimate);
  });

  router.post("/pricing-models", validate(createPricingModelSchema), async (req, res) => {
    assertInstanceAdmin(req);

    const created = await svc.createModel(
      {
        provider: req.body.provider,
        model: req.body.model,
        adapterType: req.body.adapterType ?? null,
        inputCostMicrocentsPer1k: req.body.inputCostMicrocentsPer1k,
        cachedInputCostMicrocentsPer1k: req.body.cachedInputCostMicrocentsPer1k ?? null,
        outputCostMicrocentsPer1k: req.body.outputCostMicrocentsPer1k,
        currency: req.body.currency ?? "USD",
        effectiveFrom: req.body.effectiveFrom,
        notes: req.body.notes ?? null,
      },
      { userId: req.actor.userId ?? null },
    );

    res.status(201).json(created);
  });

  router.patch("/pricing-models/:id", validate(updatePricingModelSchema), async (req, res) => {
    assertInstanceAdmin(req);

    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Pricing model not found" });
      return;
    }

    const updated = await svc.updateModel(
      req.params.id as string,
      {
        inputCostMicrocentsPer1k: req.body.inputCostMicrocentsPer1k,
        cachedInputCostMicrocentsPer1k: req.body.cachedInputCostMicrocentsPer1k,
        outputCostMicrocentsPer1k: req.body.outputCostMicrocentsPer1k,
        currency: req.body.currency,
        notes: req.body.notes,
      },
      { userId: req.actor.userId ?? null },
    );

    res.json(updated);
  });

  router.post("/pricing-models/:id/deactivate", async (req, res) => {
    assertInstanceAdmin(req);

    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      throw notFound("Pricing model not found");
    }

    const updated = await svc.deactivateModel(
      req.params.id as string,
      { userId: req.actor.userId ?? null },
    );

    res.json(updated);
  });

  return router;
}
