import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { billingApi } from "../api/billing";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Receipt, Download } from "lucide-react";

function invoiceStatusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "paid":
      return "default";
    case "open":
      return "secondary";
    case "void":
    case "uncollectible":
      return "destructive";
    default:
      return "outline";
  }
}

function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

export function BillingInvoices() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Billing", href: "../billing" }, { label: "Invoices" }]);
  }, [setBreadcrumbs]);

  const companyId = selectedCompanyId ?? "";

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.billing.invoices(companyId),
    queryFn: () => billingApi.invoices(companyId),
    enabled: !!companyId,
  });

  if (!companyId) {
    return <EmptyState icon={Receipt} message="Select a company to view invoices." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const invoices = data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Invoices</h1>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {invoices.length === 0 && (
        <EmptyState icon={Receipt} message="No invoices found." />
      )}

      {invoices.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Amount Due</th>
                <th className="px-4 py-2 text-right font-medium">Amount Paid</th>
                <th className="px-4 py-2 text-left font-medium">Period</th>
                <th className="px-4 py-2 text-right font-medium">PDF</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                    {inv.paidAt
                      ? new Date(inv.paidAt).toLocaleDateString()
                      : inv.periodStart
                        ? new Date(inv.periodStart).toLocaleDateString()
                        : "-"}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={invoiceStatusVariant(inv.status)}>
                      {inv.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {formatCents(inv.amountDueCents, inv.currency)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {formatCents(inv.amountPaidCents, inv.currency)}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                    {inv.periodStart && inv.periodEnd
                      ? `${new Date(inv.periodStart).toLocaleDateString()} - ${new Date(inv.periodEnd).toLocaleDateString()}`
                      : "-"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {inv.invoicePdf && (
                      <a
                        href={inv.invoicePdf}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Download className="h-3 w-3" />
                        PDF
                      </a>
                    )}
                    {inv.hostedInvoiceUrl && !inv.invoicePdf && (
                      <a
                        href={inv.hostedInvoiceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        View
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
