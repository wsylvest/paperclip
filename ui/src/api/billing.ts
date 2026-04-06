import { api } from "./client";

export interface SubscriptionInfo {
  companyId: string;
  stripeCustomerId: string | null;
  subscriptionStatus: string | null;
  currentPlanId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export interface SubscriptionPlan {
  id: string;
  name: string;
  baseMonthlyCents: number;
  includedUsageCents: number;
  overageRateCentsPer1000: number;
  features: Record<string, unknown> | null;
  isActive: boolean;
}

export interface StripeInvoice {
  id: string;
  stripeInvoiceId: string;
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
}

export interface PaymentMethod {
  id: string;
  type: string;
  last4: string | null;
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

export const billingApi = {
  subscription: (companyId: string) =>
    api.get<SubscriptionInfo>(`/companies/${companyId}/billing/subscription`),
  checkout: (companyId: string, input: { planId: string; successUrl: string; cancelUrl: string }) =>
    api.post<{ sessionId: string; url: string }>(`/companies/${companyId}/billing/checkout`, input),
  updateSubscription: (companyId: string, input: { planId: string }) =>
    api.put<SubscriptionInfo>(`/companies/${companyId}/billing/subscription`, input),
  cancelSubscription: (companyId: string, input?: { atPeriodEnd?: boolean }) =>
    api.delete<SubscriptionInfo>(`/companies/${companyId}/billing/subscription`),
  invoices: (companyId: string) =>
    api.get<StripeInvoice[]>(`/companies/${companyId}/billing/invoices`),
  paymentMethods: (companyId: string) =>
    api.get<PaymentMethod[]>(`/companies/${companyId}/billing/payment-methods`),
  portalSession: (companyId: string, returnUrl: string) =>
    api.post<{ url: string }>(`/companies/${companyId}/billing/portal-session`, { returnUrl }),
  plans: (companyId: string) =>
    api.get<SubscriptionPlan[]>(`/companies/${companyId}/billing/plans`),
};
