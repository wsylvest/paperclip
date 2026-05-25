import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, Wrench, DollarSign } from "lucide-react";
import { formatCents } from "../lib/utils";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
  mcp_tool_call: "MCP Tool Call",
  pre_run_cost_estimate: "Pre-run Cost Estimate",
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null, type?: string): string | null {
  if (type === "mcp_tool_call" && payload) {
    const serverName = typeof payload.serverName === "string" ? payload.serverName : null;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
    if (serverName && toolName) return `${serverName}.${toolName}`;
    if (toolName) return toolName;
  }
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload, type);
  if (subject) {
    return `${base}: ${subject}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
  mcp_tool_call: Wrench,
  pre_run_cost_estimate: DollarSign,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Summary</p>
          <p className="leading-6 text-foreground/90">{summary}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{recommendedAction}</p>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">On approval</p>
          <p className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</p>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Proposed comment
          </p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

function formatMicrocents(microcents: number): string {
  const dollars = microcents / 1_000_000;
  return `$${dollars.toFixed(4)}`;
}

export function PreRunCostEstimatePayload({ payload }: { payload: Record<string, unknown> }) {
  const estimate = typeof payload.estimate === "object" && payload.estimate !== null
    ? (payload.estimate as Record<string, unknown>)
    : null;
  const taskPreview = typeof payload.taskPreview === "string" ? payload.taskPreview : null;
  const thresholdMicrocents = typeof payload.threshold === "number" ? payload.threshold : null;

  const totalCostMicrocents = typeof estimate?.totalCostMicrocents === "number"
    ? estimate.totalCostMicrocents
    : null;
  const provider = typeof estimate?.provider === "string" ? estimate.provider : null;
  const model = typeof estimate?.model === "string" ? estimate.model : null;
  const confidence = typeof estimate?.confidence === "string" ? estimate.confidence : null;
  const inputTokens = typeof estimate?.inputTokens === "number" ? estimate.inputTokens : null;
  const outputTokens = typeof estimate?.outputTokens === "number" ? estimate.outputTokens : null;
  const cachedInputTokens = typeof estimate?.cachedInputTokens === "number" ? estimate.cachedInputTokens : null;

  return (
    <div className="mt-3 space-y-2 text-sm">
      {totalCostMicrocents !== null && (
        <div className="rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300 uppercase tracking-wide">Estimated Cost</p>
          <p className="text-lg font-semibold mt-0.5">{formatMicrocents(totalCostMicrocents)}</p>
          {thresholdMicrocents !== null && (
            <p className="text-xs text-muted-foreground mt-0.5">Threshold: {formatMicrocents(thresholdMicrocents)}</p>
          )}
        </div>
      )}
      {(provider || model) && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Model</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {provider}{model ? `/${model}` : ""}
          </span>
        </div>
      )}
      {confidence && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Confidence</span>
          <span className="text-muted-foreground">{confidence}</span>
        </div>
      )}
      {(inputTokens !== null || outputTokens !== null) && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Tokens</span>
          <span className="text-muted-foreground text-xs">
            {inputTokens !== null ? `${inputTokens.toLocaleString()} in` : ""}
            {cachedInputTokens ? ` (${cachedInputTokens.toLocaleString()} cached)` : ""}
            {outputTokens !== null ? ` / ${outputTokens.toLocaleString()} out` : ""}
          </span>
        </div>
      )}
      {taskPreview && (
        <div className="space-y-1 mt-2">
          <span className="text-muted-foreground text-xs">Task preview</span>
          <pre className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-32 whitespace-pre-wrap">
            {taskPreview.slice(0, 500)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function McpToolCallPayload({ payload }: { payload: Record<string, unknown> }) {
  const serverName = typeof payload.serverName === "string" ? payload.serverName : null;
  const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
  const previewB64 = typeof payload.requestPayloadPreview === "string" ? payload.requestPayloadPreview : null;

  let previewText: string | null = null;
  if (previewB64) {
    try {
      const decoded = atob(previewB64);
      // Try to pretty-print as JSON
      previewText = JSON.stringify(JSON.parse(decoded), null, 2);
    } catch {
      // If atob or JSON.parse fails, fall back to raw
      try {
        previewText = atob(previewB64);
      } catch {
        previewText = previewB64;
      }
    }
  }

  return (
    <div className="mt-3 space-y-1.5 text-sm">
      {serverName && toolName && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Tool</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {serverName}.{toolName}
          </span>
        </div>
      )}
      {previewText && (
        <div className="mt-2 space-y-1">
          <span className="text-muted-foreground text-xs">Arguments preview (first 2 KB)</span>
          <pre className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48 whitespace-pre-wrap">
            {previewText}
          </pre>
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  if (type === "mcp_tool_call") return <McpToolCallPayload payload={payload} />;
  if (type === "pre_run_cost_estimate") return <PreRunCostEstimatePayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
