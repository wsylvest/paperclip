import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DollarSign, Edit3, Plus, PowerOff } from "lucide-react";
import type { PricingModel } from "@paperclipai/shared";
import { useToastActions } from "../context/ToastContext";
import { pricingApi } from "../api/pricing";
import type { CreatePricingModelInput, UpdatePricingModelInput } from "../api/pricing";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";

function formatMicrocentsPer1k(microcents: number | null | undefined): string {
  if (microcents == null) return "—";
  // microcents per 1k tokens → dollars per 1M tokens = microcents / 1k * 1M / 1e6 = microcents
  const dollarsPerMillion = microcents / 1_000_000;
  return `$${dollarsPerMillion.toFixed(4)}/1M`;
}

interface ModelFormState {
  provider: string;
  model: string;
  adapterType: string;
  inputCostMicrocentsPer1k: string;
  cachedInputCostMicrocentsPer1k: string;
  outputCostMicrocentsPer1k: string;
  currency: string;
  notes: string;
}

function emptyForm(): ModelFormState {
  return {
    provider: "",
    model: "",
    adapterType: "",
    inputCostMicrocentsPer1k: "",
    cachedInputCostMicrocentsPer1k: "",
    outputCostMicrocentsPer1k: "",
    currency: "USD",
    notes: "",
  };
}

function modelToForm(m: PricingModel): ModelFormState {
  return {
    provider: m.provider,
    model: m.model,
    adapterType: m.adapterType ?? "",
    inputCostMicrocentsPer1k: String(m.inputCostMicrocentsPer1k),
    cachedInputCostMicrocentsPer1k: m.cachedInputCostMicrocentsPer1k != null ? String(m.cachedInputCostMicrocentsPer1k) : "",
    outputCostMicrocentsPer1k: String(m.outputCostMicrocentsPer1k),
    currency: m.currency,
    notes: m.notes ?? "",
  };
}

export function PricingModels() {
  const qc = useQueryClient();
  const { pushToast } = useToastActions();
  const [addOpen, setAddOpen] = useState(false);
  const [editModel, setEditModel] = useState<PricingModel | null>(null);
  const [form, setForm] = useState<ModelFormState>(emptyForm());

  const { data: models = [], isLoading } = useQuery({
    queryKey: queryKeys.pricing.models(),
    queryFn: () => pricingApi.listModels(),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreatePricingModelInput) => pricingApi.createModel(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.pricing.models() });
      pushToast({ title: "Pricing model created", tone: "success" });
      setAddOpen(false);
      setForm(emptyForm());
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to create pricing model", body: err.message, tone: "error" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdatePricingModelInput }) =>
      pricingApi.updateModel(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.pricing.models() });
      pushToast({ title: "Pricing model updated", tone: "success" });
      setEditModel(null);
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to update pricing model", body: err.message, tone: "error" });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => pricingApi.deactivateModel(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.pricing.models() });
      pushToast({ title: "Pricing model deactivated", tone: "success" });
    },
    onError: (err: Error) => {
      pushToast({ title: "Failed to deactivate", body: err.message, tone: "error" });
    },
  });

  function handleAddSubmit(e: React.FormEvent) {
    e.preventDefault();
    const inputCost = parseInt(form.inputCostMicrocentsPer1k, 10);
    const outputCost = parseInt(form.outputCostMicrocentsPer1k, 10);
    const cachedCost = form.cachedInputCostMicrocentsPer1k
      ? parseInt(form.cachedInputCostMicrocentsPer1k, 10)
      : null;

    if (isNaN(inputCost) || isNaN(outputCost)) return;

    createMutation.mutate({
      provider: form.provider.trim(),
      model: form.model.trim(),
      adapterType: form.adapterType.trim() || null,
      inputCostMicrocentsPer1k: inputCost,
      cachedInputCostMicrocentsPer1k: cachedCost,
      outputCostMicrocentsPer1k: outputCost,
      currency: form.currency.trim() || "USD",
      notes: form.notes.trim() || null,
    });
  }

  function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editModel) return;

    const inputCost = parseInt(form.inputCostMicrocentsPer1k, 10);
    const outputCost = parseInt(form.outputCostMicrocentsPer1k, 10);
    const cachedCost = form.cachedInputCostMicrocentsPer1k
      ? parseInt(form.cachedInputCostMicrocentsPer1k, 10)
      : null;

    updateMutation.mutate({
      id: editModel.id,
      patch: {
        inputCostMicrocentsPer1k: isNaN(inputCost) ? undefined : inputCost,
        cachedInputCostMicrocentsPer1k: cachedCost,
        outputCostMicrocentsPer1k: isNaN(outputCost) ? undefined : outputCost,
        currency: form.currency.trim() || undefined,
        notes: form.notes.trim() || null,
      },
    });
  }

  function openEdit(model: PricingModel) {
    setEditModel(model);
    setForm(modelToForm(model));
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Pricing Models</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Instance-wide LLM pricing used for pre-run cost estimates.
          </p>
        </div>
        <Button onClick={() => { setAddOpen(true); setForm(emptyForm()); }} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Add model
        </Button>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : models.length === 0 ? (
        <EmptyState icon={DollarSign} message="No pricing models — add one to enable pre-run cost estimates." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Model</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Adapter</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Input $/1M</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Cached $/1M</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Output $/1M</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Currency</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Effective from</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Active</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr
                  key={m.id}
                  className={cn("border-b border-border last:border-0", !m.active && "opacity-50")}
                >
                  <td className="px-4 py-3 font-mono text-xs">{m.provider}</td>
                  <td className="px-4 py-3 font-mono text-xs">{m.model}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.adapterType ?? "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatMicrocentsPer1k(m.inputCostMicrocentsPer1k)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatMicrocentsPer1k(m.cachedInputCostMicrocentsPer1k)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatMicrocentsPer1k(m.outputCostMicrocentsPer1k)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.currency}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {new Date(m.effectiveFrom).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn("text-xs font-medium", m.active ? "text-emerald-600" : "text-muted-foreground")}>
                      {m.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(m)} title="Edit">
                        <Edit3 className="h-4 w-4" />
                      </Button>
                      {m.active && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deactivateMutation.mutate(m.id)}
                          disabled={deactivateMutation.isPending}
                          title="Deactivate"
                        >
                          <PowerOff className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add modal */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Pricing Model</DialogTitle>
            <DialogDescription>
              Define per-1k-token costs in microcents (1 microcent = $0.000001).
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddSubmit} className="space-y-3">
            <ModelFormFields form={form} setForm={setForm} isCreate />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit modal */}
      <Dialog open={!!editModel} onOpenChange={(open) => { if (!open) setEditModel(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Pricing Model</DialogTitle>
            <DialogDescription>
              Update the cost rates for {editModel?.provider} / {editModel?.model}.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="space-y-3">
            <ModelFormFields form={form} setForm={setForm} isCreate={false} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditModel(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModelFormFields({
  form,
  setForm,
  isCreate,
}: {
  form: ModelFormState;
  setForm: React.Dispatch<React.SetStateAction<ModelFormState>>;
  isCreate: boolean;
}) {
  const set = (key: keyof ModelFormState, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <>
      {isCreate && (
        <>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Provider</label>
            <Input
              value={form.provider}
              onChange={(e) => set("provider", e.target.value)}
              placeholder="anthropic"
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            <Input
              value={form.model}
              onChange={(e) => set("model", e.target.value)}
              placeholder="claude-sonnet-4-5"
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Adapter type (optional)</label>
            <Input
              value={form.adapterType}
              onChange={(e) => set("adapterType", e.target.value)}
              placeholder="claude_local"
            />
          </div>
        </>
      )}
      <div>
        <label className="text-xs font-medium text-muted-foreground">Input cost (microcents/1k tokens)</label>
        <Input
          type="number"
          min={0}
          value={form.inputCostMicrocentsPer1k}
          onChange={(e) => set("inputCostMicrocentsPer1k", e.target.value)}
          required
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">Cached input cost (microcents/1k, blank = same as input)</label>
        <Input
          type="number"
          min={0}
          value={form.cachedInputCostMicrocentsPer1k}
          onChange={(e) => set("cachedInputCostMicrocentsPer1k", e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">Output cost (microcents/1k tokens)</label>
        <Input
          type="number"
          min={0}
          value={form.outputCostMicrocentsPer1k}
          onChange={(e) => set("outputCostMicrocentsPer1k", e.target.value)}
          required
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">Currency</label>
        <Input
          value={form.currency}
          onChange={(e) => set("currency", e.target.value)}
          placeholder="USD"
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
        <Input
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Provider docs URL, version, etc."
        />
      </div>
    </>
  );
}
