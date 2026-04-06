import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  stripeCustomers,
  subscriptionPlans,
  stripeInvoices,
  paymentMethods,
} from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { loadConfig } from "../config.js";

// Lazy Stripe SDK initialization
let _stripe: any = null;
function getStripe() {
  if (!_stripe) {
    const config = loadConfig();
    if (!config.stripeEnabled || !config.stripeSecretKey) {
      throw unprocessable("Stripe is not configured");
    }
    try {
      // Dynamic import would be ideal but we use require for sync
      const Stripe = require("stripe").default ?? require("stripe");
      _stripe = new Stripe(config.stripeSecretKey);
    } catch {
      throw unprocessable("Stripe SDK not installed. Run: pnpm add stripe");
    }
  }
  return _stripe;
}

export function stripeService(db: Db) {
  return {
    createCustomer: async (companyId: string, email: string) => {
      const stripe = getStripe();
      const customer = await stripe.customers.create({
        email,
        metadata: { companyId },
      });

      const [record] = await db
        .insert(stripeCustomers)
        .values({
          companyId,
          stripeCustomerId: customer.id,
        })
        .returning();

      return record;
    },

    createCheckoutSession: async (
      companyId: string,
      planId: string,
      successUrl: string,
      cancelUrl: string,
    ) => {
      const stripe = getStripe();

      const [plan] = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .limit(1);

      if (!plan) {
        throw notFound("Subscription plan not found");
      }

      if (!plan.stripePriceId) {
        throw unprocessable("Plan does not have a Stripe price configured");
      }

      // Look up or create stripe customer
      let [customer] = await db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.companyId, companyId))
        .limit(1);

      if (!customer) {
        const stripeCustomer = await stripe.customers.create({
          metadata: { companyId },
        });
        [customer] = await db
          .insert(stripeCustomers)
          .values({
            companyId,
            stripeCustomerId: stripeCustomer.id,
          })
          .returning();
      }

      const session = await stripe.checkout.sessions.create({
        customer: customer.stripeCustomerId,
        mode: "subscription",
        line_items: [{ price: plan.stripePriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { companyId, planId },
      });

      return { sessionId: session.id, url: session.url };
    },

    getSubscription: async (companyId: string) => {
      const [customer] = await db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.companyId, companyId))
        .limit(1);

      if (!customer) {
        return null;
      }

      let plan = null;
      if (customer.currentPlanId) {
        const [found] = await db
          .select()
          .from(subscriptionPlans)
          .where(eq(subscriptionPlans.id, customer.currentPlanId))
          .limit(1);
        plan = found ?? null;
      }

      return {
        stripeCustomerId: customer.stripeCustomerId,
        stripeSubscriptionId: customer.stripeSubscriptionId,
        subscriptionStatus: customer.subscriptionStatus,
        currentPeriodStart: customer.currentPeriodStart,
        currentPeriodEnd: customer.currentPeriodEnd,
        trialEndsAt: customer.trialEndsAt,
        plan,
      };
    },

    cancelSubscription: async (companyId: string, atPeriodEnd: boolean) => {
      const stripe = getStripe();

      const [customer] = await db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.companyId, companyId))
        .limit(1);

      if (!customer) {
        throw notFound("Stripe customer not found for this company");
      }

      if (!customer.stripeSubscriptionId) {
        throw unprocessable("No active subscription to cancel");
      }

      await stripe.subscriptions.update(customer.stripeSubscriptionId, {
        cancel_at_period_end: atPeriodEnd,
      });

      const newStatus = atPeriodEnd ? "cancel_at_period_end" : "canceled";

      const [updated] = await db
        .update(stripeCustomers)
        .set({
          subscriptionStatus: newStatus,
          updatedAt: new Date(),
        })
        .where(eq(stripeCustomers.companyId, companyId))
        .returning();

      return updated;
    },

    reportUsage: async (companyId: string, amountCents: number) => {
      const stripe = getStripe();

      const [customer] = await db
        .select()
        .from(stripeCustomers)
        .where(
          and(
            eq(stripeCustomers.companyId, companyId),
            eq(stripeCustomers.subscriptionStatus, "active"),
          ),
        )
        .limit(1);

      if (!customer || !customer.stripeSubscriptionId) {
        throw unprocessable("No active subscription found for usage reporting");
      }

      // Retrieve the subscription to find the metered subscription item
      const subscription = await stripe.subscriptions.retrieve(
        customer.stripeSubscriptionId,
      );

      const meteredItem = subscription.items?.data?.find(
        (item: any) => item.price?.recurring?.usage_type === "metered",
      );

      if (meteredItem) {
        await stripe.subscriptionItems.createUsageRecord(meteredItem.id, {
          quantity: amountCents,
          timestamp: Math.floor(Date.now() / 1000),
          action: "increment",
        });
      }

      return { reported: true, amountCents };
    },

    listInvoices: async (companyId: string) => {
      const rows = await db
        .select()
        .from(stripeInvoices)
        .where(eq(stripeInvoices.companyId, companyId))
        .orderBy(desc(stripeInvoices.createdAt));

      return rows;
    },

    getPortalSession: async (companyId: string, returnUrl: string) => {
      const stripe = getStripe();

      const [customer] = await db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.companyId, companyId))
        .limit(1);

      if (!customer) {
        throw notFound("Stripe customer not found for this company");
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: customer.stripeCustomerId,
        return_url: returnUrl,
      });

      return { url: session.url };
    },

    listPlans: async () => {
      const rows = await db
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.isActive, true))
        .orderBy(subscriptionPlans.displayOrder);

      return rows;
    },

    listPaymentMethods: async (companyId: string) => {
      const rows = await db
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.companyId, companyId));

      return rows;
    },
  };
}
