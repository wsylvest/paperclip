import path from "node:path";
import { materializeMcpConfig } from "@paperclipai/adapter-utils/mcp-config";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface PreparedCursorMcpConfig {
  projectFilePath: string;
  apiKeyId: string;
  expiresAt: string;
}

/**
 * Cursor uses the same JSON shape as Claude Code's .mcp.json but places the
 * file at <workspaceCwd>/.cursor/mcp.json instead of <workspaceCwd>/.mcp.json.
 *
 * There is no user-scope seed concept for cursor-local so only the
 * project-scope file is written.
 */
function buildCursorJsonEntry(
  existing: Record<string, unknown> | null,
  entry: { url: string; bearerToken: string },
): Record<string, unknown> {
  const base = existing ?? {};
  const existingServers = (base.mcpServers as Record<string, unknown>) ?? {};
  return {
    ...base,
    mcpServers: {
      ...existingServers,
      paperclip: {
        type: "http",
        url: entry.url,
        headers: {
          Authorization: `Bearer ${entry.bearerToken}`,
        },
      },
    },
  };
}

export async function prepareCursorMcpConfig(input: {
  workspaceCwd: string;
  ctx: AdapterExecutionContext;
  companyId: string;
  agentId: string;
  runId: string;
}): Promise<PreparedCursorMcpConfig | null> {
  const { workspaceCwd, ctx, companyId, agentId, runId } = input;

  const projectFilePath = path.join(workspaceCwd, ".cursor", "mcp.json");

  const result = await materializeMcpConfig({
    ctx,
    companyId,
    agentId,
    runId,
    targets: [
      {
        filePath: projectFilePath,
        format: "json",
        merge: buildCursorJsonEntry,
      },
    ],
  });

  if (!result) return null;

  return {
    projectFilePath,
    apiKeyId: result.apiKeyId,
    expiresAt: result.expiresAt,
  };
}
