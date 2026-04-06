import { z } from "zod";

export const createCheckoutSessionSchema = z.object({
  planId: z.string().uuid(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export type CreateCheckoutSession = z.infer<typeof createCheckoutSessionSchema>;

export const updateSubscriptionSchema = z.object({
  planId: z.string().uuid(),
});

export type UpdateSubscription = z.infer<typeof updateSubscriptionSchema>;

export const cancelSubscriptionSchema = z.object({
  atPeriodEnd: z.boolean().default(true),
});

export type CancelSubscription = z.infer<typeof cancelSubscriptionSchema>;
