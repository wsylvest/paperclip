import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { billingRoutes } from "../routes/billing.js";

const mockStripeService = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  cancelSubscription: vi.fn(),
  listInvoices: vi.fn(),
  listPaymentMethods: vi.fn(),
  getPortalSession: vi.fn(),
  listPlans: vi.fn(),
}));

const mockStripeWebhookService = vi.hoisted(() => ({
  handleEvent: vi.fn(),
}));

vi.mock("../services/stripe.js", () => ({
  stripeService: () => mockStripeService,
}));

vi.mock("../services/stripe-webhooks.js", () => ({
  stripeWebhookService: () => mockStripeWebhookService,
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", billingRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "local-board",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: ["company-1"],
};

const otherCompanyActor = {
  type: "board",
  userId: "user-2",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-other"],
};

describe("billing routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /companies/:companyId/billing/subscription", () => {
    it("returns the current subscription for an authorized user", async () => {
      const subscription = {
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_456",
        subscriptionStatus: "active",
        currentPeriodStart: "2026-03-01T00:00:00Z",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        plan: { id: "plan-1", name: "Pro" },
      };
      mockStripeService.getSubscription.mockResolvedValue(subscription);

      const app = createApp(boardActor);
      const res = await request(app).get("/api/companies/company-1/billing/subscription");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(subscription);
      expect(mockStripeService.getSubscription).toHaveBeenCalledWith("company-1");
    });

    it("returns null when no subscription exists", async () => {
      mockStripeService.getSubscription.mockResolvedValue(null);

      const app = createApp(boardActor);
      const res = await request(app).get("/api/companies/company-1/billing/subscription");

      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it("rejects access for unauthorized company", async () => {
      const app = createApp(otherCompanyActor);
      const res = await request(app).get("/api/companies/company-1/billing/subscription");

      expect(res.status).toBe(403);
    });
  });

  describe("GET /companies/:companyId/billing/invoices", () => {
    it("returns a list of invoices", async () => {
      const invoices = [
        {
          id: "inv-1",
          stripeInvoiceId: "in_abc",
          status: "paid",
          amountDueCents: 5000,
          amountPaidCents: 5000,
          currency: "usd",
        },
      ];
      mockStripeService.listInvoices.mockResolvedValue(invoices);

      const app = createApp(boardActor);
      const res = await request(app).get("/api/companies/company-1/billing/invoices");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(invoices);
      expect(mockStripeService.listInvoices).toHaveBeenCalledWith("company-1");
    });

    it("returns empty array when no invoices exist", async () => {
      mockStripeService.listInvoices.mockResolvedValue([]);

      const app = createApp(boardActor);
      const res = await request(app).get("/api/companies/company-1/billing/invoices");

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("GET /companies/:companyId/billing/payment-methods", () => {
    it("returns payment methods", async () => {
      const methods = [
        { id: "pm-1", type: "card", last4: "4242", brand: "visa", isDefault: true },
      ];
      mockStripeService.listPaymentMethods.mockResolvedValue(methods);

      const app = createApp(boardActor);
      const res = await request(app).get("/api/companies/company-1/billing/payment-methods");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(methods);
      expect(mockStripeService.listPaymentMethods).toHaveBeenCalledWith("company-1");
    });
  });

  describe("GET /companies/:companyId/billing/plans", () => {
    it("returns available plans", async () => {
      const plans = [
        { id: "plan-1", name: "Starter", baseMonthlyCents: 2900, isActive: true },
        { id: "plan-2", name: "Pro", baseMonthlyCents: 9900, isActive: true },
      ];
      mockStripeService.listPlans.mockResolvedValue(plans);

      const app = createApp(boardActor);
      const res = await request(app).get("/api/companies/company-1/billing/plans");

      expect(res.status).toBe(200);
      expect(res.body).toEqual(plans);
      expect(mockStripeService.listPlans).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /companies/:companyId/billing/portal-session", () => {
    it("returns a portal URL", async () => {
      mockStripeService.getPortalSession.mockResolvedValue({ url: "https://billing.stripe.com/session/xyz" });

      const app = createApp(boardActor);
      const res = await request(app)
        .post("/api/companies/company-1/billing/portal-session")
        .send({ returnUrl: "https://app.example.com/billing" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ url: "https://billing.stripe.com/session/xyz" });
      expect(mockStripeService.getPortalSession).toHaveBeenCalledWith("company-1", "https://app.example.com/billing");
    });
  });

  describe("DELETE /companies/:companyId/billing/subscription", () => {
    it("cancels the subscription at period end by default", async () => {
      const updated = { subscriptionStatus: "cancel_at_period_end" };
      mockStripeService.cancelSubscription.mockResolvedValue(updated);

      const app = createApp(boardActor);
      const res = await request(app)
        .delete("/api/companies/company-1/billing/subscription")
        .send({ atPeriodEnd: true });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(updated);
      expect(mockStripeService.cancelSubscription).toHaveBeenCalledWith("company-1", true);
    });
  });

  describe("POST /webhooks/stripe", () => {
    it("handles a valid webhook event and returns 200", async () => {
      mockStripeWebhookService.handleEvent.mockResolvedValue(undefined);

      // The webhook route uses express.raw() middleware, so we need a separate app
      // without the JSON parser for the webhook path
      const app = express();
      app.use((req, _res, next) => {
        req.actor = boardActor;
        next();
      });
      app.use("/api", billingRoutes({} as any));
      app.use(errorHandler);

      const payload = JSON.stringify({ type: "invoice.paid", data: {} });
      const res = await request(app)
        .post("/api/webhooks/stripe")
        .set("Content-Type", "application/json")
        .set("stripe-signature", "t=123,v1=abc")
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(mockStripeWebhookService.handleEvent).toHaveBeenCalledTimes(1);
    });
  });
});
