import { useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { billingApi } from "../api/billing";
import type { SubscriptionPlan, PaymentMethod as PaymentMethodType } from "../api/billing";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CreditCard, ExternalLink, Receipt } from "lucide-react";

function statusVariant(status: string | null): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active":
      return "default";
    case "trialing":
      return "secondary";
    case "past_due":
    case "canceled":
      return "destructive";
    default:
      return "outline";
  }
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function Billing() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Billing" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const subscriptionQuery = useQuery({
    queryKey: queryKeys.billing.subscription(companyId),
    queryFn: () => billingApi.subscription(companyId),
    enabled: !!companyId,
  });

  const plansQuery = useQuery({
    queryKey: queryKeys.billing.plans(companyId),
    queryFn: () => billingApi.plans(companyId),
    enabled: !!companyId,
  });

  const paymentMethodsQuery = useQuery({
    queryKey: queryKeys.billing.paymentMethods(companyId),
    queryFn: () => billingApi.paymentMethods(companyId),
    enabled: !!companyId,
  });

  const portalMutation = useMutation({
    mutationFn: () => billingApi.portalSession(companyId, window.location.href),
    onSuccess: (data) => {
      if (data.url) {
        window.location.href = data.url;
      }
    },
  });

  if (!companyId) {
    return <EmptyState icon={CreditCard} message="Select a company to view billing." />;
  }

  if (subscriptionQuery.isLoading || plansQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const subscription = subscriptionQuery.data;
  const plans: SubscriptionPlan[] = plansQuery.data ?? [];
  const methods: PaymentMethodType[] = paymentMethodsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Billing</h1>
        <div className="flex gap-2">
          <Link to="billing/invoices">
            <Button variant="outline" size="sm">
              <Receipt className="h-3.5 w-3.5 mr-1.5" />
              Invoices
            </Button>
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => portalMutation.mutate()}
            disabled={portalMutation.isPending}
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
            Billing Portal
          </Button>
        </div>
      </div>

      {/* Current Subscription */}
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-medium text-muted-foreground mb-3">Current Subscription</h2>
        {subscription ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">
                {subscription.currentPlanId ?? "No plan"}
              </span>
              <Badge variant={statusVariant(subscription.subscriptionStatus)}>
                {subscription.subscriptionStatus ?? "inactive"}
              </Badge>
            </div>
            {subscription.currentPeriodStart && subscription.currentPeriodEnd && (
              <p className="text-sm text-muted-foreground">
                Current period: {new Date(subscription.currentPeriodStart).toLocaleDateString()}
                {" - "}
                {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No active subscription.</p>
        )}
      </div>

      {/* Available Plans */}
      {plans.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Available Plans</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="rounded-lg border border-border bg-card p-5 flex flex-col"
              >
                <h3 className="font-semibold">{plan.name}</h3>
                <p className="text-2xl font-bold mt-2">
                  {formatCents(plan.baseMonthlyCents)}
                  <span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                <div className="mt-3 text-sm text-muted-foreground space-y-1 flex-1">
                  <p>Includes {formatCents(plan.includedUsageCents)} usage</p>
                  <p>Overage: {formatCents(plan.overageRateCentsPer1000)}/1k units</p>
                </div>
                {subscription?.currentPlanId === plan.id ? (
                  <Badge variant="secondary" className="mt-4 w-fit">Current plan</Badge>
                ) : (
                  <div className="mt-4" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Payment Methods */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">Payment Methods</h2>
        {methods.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payment methods on file.</p>
        ) : (
          <div className="space-y-2">
            {methods.map((pm) => (
              <div
                key={pm.id}
                className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3"
              >
                <CreditCard className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {pm.brand ? pm.brand.charAt(0).toUpperCase() + pm.brand.slice(1) : pm.type}
                </span>
                {pm.last4 && (
                  <span className="text-sm text-muted-foreground font-mono">
                    **** {pm.last4}
                  </span>
                )}
                {pm.expMonth != null && pm.expYear != null && (
                  <span className="text-sm text-muted-foreground">
                    {String(pm.expMonth).padStart(2, "0")}/{pm.expYear}
                  </span>
                )}
                {pm.isDefault && (
                  <Badge variant="secondary" className="ml-auto">Default</Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
