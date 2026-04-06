import { Router } from "express";
import express from "express";
import type { Db } from "@paperclipai/db";
import {
  createCheckoutSessionSchema,
  updateSubscriptionSchema,
  cancelSubscriptionSchema,
} from "@paperclipai/shared";
import { stripeService } from "../services/stripe.js";
import { stripeWebhookService } from "../services/stripe-webhooks.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function billingRoutes(db: Db) {
  const router = Router();
  const svc = stripeService(db);
  const webhookSvc = stripeWebhookService(db);

  router.get("/companies/:companyId/billing/subscription", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.getSubscription(companyId);
    res.json(result);
  });

  router.post(
    "/companies/:companyId/billing/checkout",
    validate(createCheckoutSessionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { planId, successUrl, cancelUrl } = req.body;
      const result = await svc.createCheckoutSession(companyId, planId, successUrl, cancelUrl);
      res.json(result);
    },
  );

  router.put(
    "/companies/:companyId/billing/subscription",
    validate(updateSubscriptionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { planId } = req.body;
      // For plan changes, create a new checkout session or update existing subscription
      const result = await svc.getSubscription(companyId);
      res.json(result);
    },
  );

  router.delete(
    "/companies/:companyId/billing/subscription",
    validate(cancelSubscriptionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { atPeriodEnd } = req.body;
      const result = await svc.cancelSubscription(companyId, atPeriodEnd ?? true);
      res.json(result);
    },
  );

  router.get("/companies/:companyId/billing/invoices", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listInvoices(companyId);
    res.json(result);
  });

  router.get("/companies/:companyId/billing/payment-methods", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listPaymentMethods(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/billing/portal-session", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { returnUrl } = req.body;
    const result = await svc.getPortalSession(companyId, returnUrl);
    res.json(result);
  });

  router.get("/companies/:companyId/billing/plans", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listPlans();
    res.json(result);
  });

  router.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const rawBody = req.body as Buffer;
      const signature = req.headers["stripe-signature"] as string;
      await webhookSvc.handleEvent(rawBody, signature);
      res.status(200).json({ received: true });
    },
  );

  return router;
}
