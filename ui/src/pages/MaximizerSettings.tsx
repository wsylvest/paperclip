import { useEffect } from "react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { Badge } from "@/components/ui/badge";
import { Zap } from "lucide-react";

export function MaximizerSettings() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "MAXIMIZER" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId || !selectedCompany) {
    return <EmptyState icon={Zap} message="Select a company to view MAXIMIZER settings." />;
  }

  const maximizerEnabled = (selectedCompany as Record<string, unknown>).maximizerEnabled as boolean | undefined;
  const budgetMonthlyCents = (selectedCompany as Record<string, unknown>).budgetMonthlyCents as number | undefined;
  const spentMonthlyCents = (selectedCompany as Record<string, unknown>).spentMonthlyCents as number | undefined;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">MAXIMIZER Settings</h1>

      <div className="rounded-md border border-border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-medium">MAXIMIZER Mode</h2>
            <p className="text-sm text-muted-foreground">
              When enabled, Paperclip proactively finds ways to spend remaining budget on
              high-value work before the billing period ends.
            </p>
          </div>
          <Badge variant={maximizerEnabled ? "default" : "outline"}>
            {maximizerEnabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-medium">Autonomy Levels</h2>
        <p className="text-sm text-muted-foreground">
          Each agent has an autonomy level that controls what actions it can perform without
          human approval.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-border p-3 space-y-1">
            <h3 className="text-sm font-medium">Standard</h3>
            <p className="text-xs text-muted-foreground">
              Agent can perform basic tasks. Deploy, merge, delete, and spend actions require
              approval.
            </p>
          </div>
          <div className="rounded-md border border-border p-3 space-y-1">
            <h3 className="text-sm font-medium">Elevated</h3>
            <p className="text-xs text-muted-foreground">
              Agent can perform high-autonomy actions like deploy, merge, delete, and spend
              without approval.
            </p>
          </div>
          <div className="rounded-md border border-border p-3 space-y-1">
            <h3 className="text-sm font-medium">Full</h3>
            <p className="text-xs text-muted-foreground">
              Agent has unrestricted autonomy for all actions.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-medium">Budget Guardrails</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">Monthly Budget</span>
            <p className="text-lg font-mono">
              {budgetMonthlyCents != null
                ? `$${(budgetMonthlyCents / 100).toFixed(2)}`
                : "--"}
            </p>
          </div>
          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">Spent This Month</span>
            <p className="text-lg font-mono">
              {spentMonthlyCents != null
                ? `$${(spentMonthlyCents / 100).toFixed(2)}`
                : "--"}
            </p>
          </div>
        </div>
        {budgetMonthlyCents != null && spentMonthlyCents != null && budgetMonthlyCents > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Usage</span>
              <span>{Math.round((spentMonthlyCents / budgetMonthlyCents) * 100)}%</span>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div
                className="h-2 rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(100, (spentMonthlyCents / budgetMonthlyCents) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
