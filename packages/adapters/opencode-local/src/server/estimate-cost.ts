import type { AdapterEstimateContext, CostEstimate } from "@paperclipai/adapter-utils";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const ADAPTER_TYPE = "opencode_local";

/**
 * Estimate the cost of an opencode_local run before execution.
 *
 * OpenCode uses a `provider/model` format for its model config field
 * (e.g. "anthropic/claude-sonnet-4-6"). When the config model contains a
 * slash, the part before the slash is used as the provider and the part after
 * as the model. A plain model string without a slash is used as-is with the
 * default provider. If neither is set, defaults to anthropic/claude-sonnet-4-6.
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
  const rawModel = typeof config?.model === "string" ? config.model.trim() : "";

  let provider = DEFAULT_PROVIDER;
  let model = DEFAULT_MODEL;

  if (rawModel.length > 0) {
    const slashIdx = rawModel.indexOf("/");
    if (slashIdx > 0 && slashIdx < rawModel.length - 1) {
      // OpenCode provider/model format (e.g. "anthropic/claude-sonnet-4-6")
      provider = rawModel.slice(0, slashIdx);
      model = rawModel.slice(slashIdx + 1);
    } else {
      // Plain model string — use with config provider or default
      model = rawModel;
      provider =
        typeof config?.provider === "string" && config.provider.trim().length > 0
          ? config.provider.trim()
          : DEFAULT_PROVIDER;
    }
  } else if (typeof config?.provider === "string" && config.provider.trim().length > 0) {
    provider = config.provider.trim();
  }

  return ctx.pricing.estimateFromTokens({
    provider,
    model,
    adapterType: ADAPTER_TYPE,
    inputTokens,
    outputTokens,
  });
}
