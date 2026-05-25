import type { AdapterEstimateContext, CostEstimate } from "@paperclipai/adapter-utils";

const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODEL = "gpt-5";
const ADAPTER_TYPE = "codex_local";

/**
 * Estimate the cost of a codex_local run before execution.
 *
 * Token counts are deliberately rough heuristics:
 *   - Input  = ceil(text.length / 4) + 1500 (system prompt + tool descriptions overhead)
 *             + ceil(estimatedAttachmentBytes / 4)
 *   - Output = min(8000, ceil(inputTokens * 0.3))
 *     Rationale: most CLI sessions produce ~30% of input as output, capped at 8000 tokens.
 *     This is a first-order approximation; actual usage will vary.
 *
 * Returns null when no matching pricing row is found.
 */
export async function estimateCost(ctx: AdapterEstimateContext): Promise<CostEstimate | null> {
  const text = ctx.taskInput.text;
  const attachmentBytes = ctx.taskInput.estimatedAttachmentBytes ?? 0;

  const textTokens = Math.ceil(text.length / 4);
  const attachmentTokens = Math.ceil(attachmentBytes / 4);
  const inputTokens = textTokens + 1500 + attachmentTokens;
  const outputTokens = Math.min(8000, Math.ceil(inputTokens * 0.3));

  const config = ctx.agent.adapterConfig as Record<string, unknown> | null | undefined;
  const model =
    typeof config?.model === "string" && config.model.trim().length > 0
      ? config.model.trim()
      : DEFAULT_MODEL;
  const provider =
    typeof config?.provider === "string" && config.provider.trim().length > 0
      ? config.provider.trim()
      : DEFAULT_PROVIDER;

  return ctx.pricing.estimateFromTokens({
    provider,
    model,
    adapterType: ADAPTER_TYPE,
    inputTokens,
    outputTokens,
  });
}
