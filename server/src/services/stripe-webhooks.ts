import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  stripeWebhookEvents,
  stripeCustomers,
  stripeInvoices,
} from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { logger } from "../middleware/logger.js";

// Re-use the lazy Stripe initializer from stripe service
let _stripe: any = null;
function getStripe() {
  if (!_stripe) {
    const config = loadConfig();
    if (!config.stripeEnabled || !config.stripeSecretKey) {
      throw new Error("Stripe is not configured");
    }
    try {
      const Stripe = require("stripe").default ?? require("stripe");
      _stripe = new Stripe(config.stripeSecretKey);
    } catch {
      throw new Error("Stripe SDK not installed. Run: pnpm add stripe");
    }
  }
  return _stripe;
}

export function stripeWebhookService(db: Db) {
  async function handleInvoicePaid(event: any) {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    // Look up company from stripe customer
    const [customer] = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.stripeCustomerId, customerId))
      .limit(1);

    if (!customer) {
      logger.warn({ customerId }, "Received invoice.paid for unknown customer");
      return;
    }

    await db
      .insert(stripeInvoices)
      .values({
        companyId: customer.companyId,
        stripeInvoiceId: invoice.id,
        stripeCustomerId: customerId,
        status: "paid",
        amountDueCents: invoice.amount_due ?? 0,
        amountPaidCents: invoice.amount_paid ?? 0,
        currency: invoice.currency ?? "usd",
        periodStart: invoice.period_start
          ? new Date(invoice.period_start * 1000)
          : null,
        periodEnd: invoice.period_end
          ? new Date(invoice.period_end * 1000)
          : null,
        paidAt: new Date(),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        invoicePdf: invoice.invoice_pdf ?? null,
      })
      .onConflictDoUpdate({
        target: stripeInvoices.stripeInvoiceId,
        set: {
          status: "paid",
          amountPaidCents: invoice.amount_paid ?? 0,
          paidAt: new Date(),
          updatedAt: new Date(),
        },
      });

    logger.info(
      { invoiceId: invoice.id, companyId: customer.companyId },
      "Invoice paid",
    );
  }

  async function handleInvoicePaymentFailed(event: any) {
    const invoice = event.data.object;
    const customerId = invoice.customer;

    const [customer] = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.stripeCustomerId, customerId))
      .limit(1);

    if (!customer) {
      logger.warn(
        { customerId },
        "Received invoice.payment_failed for unknown customer",
      );
      return;
    }

    const status = invoice.status ?? "payment_failed";

    await db
      .insert(stripeInvoices)
      .values({
        companyId: customer.companyId,
        stripeInvoiceId: invoice.id,
        stripeCustomerId: customerId,
        status,
        amountDueCents: invoice.amount_due ?? 0,
        amountPaidCents: invoice.amount_paid ?? 0,
        currency: invoice.currency ?? "usd",
        periodStart: invoice.period_start
          ? new Date(invoice.period_start * 1000)
          : null,
        periodEnd: invoice.period_end
          ? new Date(invoice.period_end * 1000)
          : null,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        invoicePdf: invoice.invoice_pdf ?? null,
      })
      .onConflictDoUpdate({
        target: stripeInvoices.stripeInvoiceId,
        set: {
          status,
          updatedAt: new Date(),
        },
      });

    logger.warn(
      { invoiceId: invoice.id, companyId: customer.companyId, status },
      "Invoice payment failed",
    );
  }

  async function handleSubscriptionUpdated(event: any) {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    const [customer] = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.stripeCustomerId, customerId))
      .limit(1);

    if (!customer) {
      logger.warn(
        { customerId },
        "Received subscription.updated for unknown customer",
      );
      return;
    }

    await db
      .update(stripeCustomers)
      .set({
        stripeSubscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        currentPeriodStart: subscription.current_period_start
          ? new Date(subscription.current_period_start * 1000)
          : null,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(stripeCustomers.stripeCustomerId, customerId));
  }

  async function handleCheckoutCompleted(event: any) {
    const session = event.data.object;
    const customerId = session.customer;
    const subscriptionId = session.subscription;

    const [customer] = await db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.stripeCustomerId, customerId))
      .limit(1);

    if (!customer) {
      logger.warn(
        { customerId },
        "Received checkout.session.completed for unknown customer",
      );
      return;
    }

    const planId = session.metadata?.planId ?? null;

    await db
      .update(stripeCustomers)
      .set({
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active",
        currentPlanId: planId,
        updatedAt: new Date(),
      })
      .where(eq(stripeCustomers.stripeCustomerId, customerId));
  }

  return {
    handleEvent: async (rawBody: string | Buffer, signature: string) => {
      const stripe = getStripe();
      const config = loadConfig();

      const event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        config.stripeWebhookSecret,
      );

      // Idempotency check
      const [existing] = await db
        .select()
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.stripeEventId, event.id))
        .limit(1);

      if (existing?.processed) {
        return { skipped: true };
      }

      // Insert event record
      if (!existing) {
        await db.insert(stripeWebhookEvents).values({
          stripeEventId: event.id,
          eventType: event.type,
          payload: event.data?.object ?? null,
        });
      }

      // Dispatch by event type
      try {
        switch (event.type) {
          case "invoice.paid":
            await handleInvoicePaid(event);
            break;
          case "invoice.payment_failed":
            await handleInvoicePaymentFailed(event);
            break;
          case "customer.subscription.updated":
            await handleSubscriptionUpdated(event);
            break;
          case "checkout.session.completed":
            await handleCheckoutCompleted(event);
            break;
          default:
            logger.info({ eventType: event.type }, "Unhandled Stripe event");
        }
      } catch (err: any) {
        await db
          .update(stripeWebhookEvents)
          .set({ processingError: err.message ?? "Unknown error" })
          .where(eq(stripeWebhookEvents.stripeEventId, event.id));
        throw err;
      }

      // Mark as processed
      await db
        .update(stripeWebhookEvents)
        .set({ processed: true })
        .where(eq(stripeWebhookEvents.stripeEventId, event.id));

      return { processed: true };
    },

    handleInvoicePaid,
    handleInvoicePaymentFailed,
    handleSubscriptionUpdated,
    handleCheckoutCompleted,
  };
}
