import path from "node:path";
import { materializeMcpConfig } from "@paperclipai/adapter-utils/mcp-config";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface PreparedGeminiMcpConfig {
  projectFilePath: string;
  seedFilePath: string;
  apiKeyId: string;
  expiresAt: string;
}

/**
 * Gemini CLI reads MCP servers from the `mcpServers` key inside its unified
 * settings.json. It uses `httpUrl` (not `url`) and does not require a `type`
 * discriminant. The file may contain many other keys (theme, telemetry, etc.)
 * that must be preserved on merge.
 *
 * Project-scope: <workspaceCwd>/.gemini/settings.json
 * Seed-scope:    <seedDir>/.gemini/settings.json  (if seedDir is provided)
 */
function buildGeminiJsonEntry(
  existing: Record<string, unknown> | null,
  entry: { url: string; bearerToken: string; runId: string },
): Record<string, unknown> {
  const base = existing ?? {};
  const existingServers = (base.mcpServers as Record<string, unknown>) ?? {};
  return {
    ...base,
    mcpServers: {
      ...existingServers,
      paperclip: {
        httpUrl: entry.url,
        headers: {
          Authorization: `Bearer ${entry.bearerToken}`,
          "X-Paperclip-Run-Id": entry.runId,
        },
      },
    },
  };
}

export async function prepareGeminiMcpConfig(input: {
  workspaceCwd: string;
  seedDir?: string | null;
  ctx: AdapterExecutionContext;
  companyId: string;
  agentId: string;
  runId: string;
}): Promise<PreparedGeminiMcpConfig | null> {
  const { workspaceCwd, seedDir, ctx, companyId, agentId, runId } = input;

  const projectFilePath = path.join(workspaceCwd, ".gemini", "settings.json");
  const seedFilePath = seedDir ? path.join(seedDir, ".gemini", "settings.json") : "";

  const targets = [
    {
      filePath: projectFilePath,
      format: "json" as const,
      merge: buildGeminiJsonEntry,
    },
    ...(seedDir
      ? [
          {
            filePath: seedFilePath,
            format: "json" as const,
            merge: buildGeminiJsonEntry,
          },
        ]
      : []),
  ];

  const result = await materializeMcpConfig({
    ctx,
    companyId,
    agentId,
    runId,
    targets,
  });

  if (!result) return null;

  return {
    projectFilePath,
    seedFilePath,
    apiKeyId: result.apiKeyId,
    expiresAt: result.expiresAt,
  };
}
