/**
 * Reference skill analyzer plugin — keyword overlap heuristic.
 *
 * Algorithm:
 *  1. Tokenize taskTitle + taskBody into lowercase words (alphanumeric only,
 *     length >= 3 to filter out noise words).
 *  2. For each available skill / MCP tool name, count how many of those words
 *     appear as substrings in the lowercased candidate name.
 *  3. Select items that score >= relevanceThreshold (default 1).
 *  4. Return the top maxSelected (default 5) by score descending, ties broken
 *     alphabetically for determinism.
 *
 * This is intentionally simple so it serves as a clear template for
 * replacement by an LLM-powered analyzer.
 */
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { SkillAnalyzerRequest, SkillAnalyzerResponse } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Heuristic implementation (exported for unit testing)
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  /** Minimum overlap count for an item to be selected. Default 1. */
  relevanceThreshold?: number;
  /** Maximum number of items to return per category. Default 5. */
  maxSelected?: number;
}

/**
 * Score a single candidate string against a set of task tokens.
 * Each task token that appears as a substring of the candidate (case-insensitive)
 * contributes 1 to the score.
 */
export function scoreCandidate(candidate: string, taskTokens: Set<string>): number {
  const lower = candidate.toLowerCase();
  let score = 0;
  for (const token of taskTokens) {
    if (lower.includes(token)) score++;
  }
  return score;
}

/**
 * Tokenize text into lowercase alphanumeric words of length >= 3.
 * Short words are excluded to avoid noise from articles and prepositions.
 */
export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

/**
 * Select items from a catalog that are most relevant to the task tokens.
 *
 * Returns items sorted by score descending, then alphabetically, truncated
 * to maxSelected entries at or above relevanceThreshold.
 */
export function selectRelevant(
  candidates: string[],
  taskTokens: Set<string>,
  opts: AnalyzeOptions = {},
): string[] {
  const threshold = opts.relevanceThreshold ?? 1;
  const maxItems = opts.maxSelected ?? 5;

  if (taskTokens.size === 0) return [];

  const scored = candidates
    .map((c) => ({ name: c, score: scoreCandidate(c, taskTokens) }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.name.localeCompare(b.name);
    });

  return scored.slice(0, maxItems).map((s) => s.name);
}

/**
 * Run the full analysis given a request payload.
 */
export function analyzeTask(
  request: SkillAnalyzerRequest,
  opts: AnalyzeOptions = {},
): SkillAnalyzerResponse {
  const taskTokens = tokenize(`${request.taskTitle} ${request.taskBody}`);

  const selectedSkills = selectRelevant(request.availableSkills, taskTokens, opts);
  const selectedMcpTools = selectRelevant(request.availableMcpTools, taskTokens, opts);

  const keywordsUsed = Array.from(taskTokens).sort().slice(0, 5);
  const totalSelected = selectedSkills.length + selectedMcpTools.length;

  const rationale =
    totalSelected > 0
      ? `Selected ${selectedSkills.length} skill(s) and ${selectedMcpTools.length} MCP tool(s) matching task keywords: ${keywordsUsed.join(", ")}.`
      : `No skills or MCP tools matched task keywords: ${keywordsUsed.join(", ")}.`;

  return { selectedSkills, selectedMcpTools, rationale };
}

// ---------------------------------------------------------------------------
// Plugin worker
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("skill-analyzer-keyword-example plugin setup complete");

    // Register the analyzeTask tool handler.
    ctx.tools.register(
      "analyzeTask",
      {
        displayName: "Analyze task for relevant skills",
        description:
          "Given a task title and body plus a catalog of available skills and MCP tools, returns the subset that is most relevant to the task using a keyword overlap heuristic.",
        parametersSchema: {
          type: "object",
          properties: {
            taskTitle: { type: "string" },
            taskBody: { type: "string" },
            availableSkills: { type: "array", items: { type: "string" } },
            availableMcpTools: { type: "array", items: { type: "string" } },
          },
          required: ["taskTitle", "taskBody", "availableSkills", "availableMcpTools"],
          additionalProperties: false,
        },
      },
      async (params) => {
        const request = params as SkillAnalyzerRequest;
        const response = analyzeTask(request);
        return {
          content: JSON.stringify(response),
        };
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "skill-analyzer-keyword-example ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
