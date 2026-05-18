import path from "node:path";
import { materializeMcpConfig } from "@paperclipai/adapter-utils/mcp-config";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface PreparedCodexMcpConfig {
  configFilePath: string;
  apiKeyId: string;
  expiresAt: string;
}

/**
 * Codex reads MCP servers from `$CODEX_HOME/config.toml`.
 *
 * The TOML section we write is:
 *
 *   [mcp_servers.paperclip]
 *   url = "https://..."
 *   startup_timeout_sec = 30
 *   bearer_token = "pck_..."
 *
 * We use `bearer_token` (the Codex-native field) rather than a generic
 * headers map because Codex TOML does not have a standard "headers" table
 * — the CLI injects it as a Bearer Authorization header internally.
 *
 * There is no project-level config override for Codex MCP, so only the
 * CODEX_HOME config file is written.
 */
function buildCodexTomlEntry(
  existing: Record<string, unknown> | null,
  entry: { url: string; bearerToken: string; runId: string },
): Record<string, unknown> {
  // Codex TOML has no per-server custom-header field, so we cannot emit
  // X-Paperclip-Run-Id from this adapter. Cost attribution for Codex runs
  // falls back to heartbeatRunId=null until the Codex CLI grows a headers
  // map (or we move to a JWT that carries the runId claim).
  void entry.runId;
  const base = existing ?? {};
  const existingMcpServers = (base.mcp_servers as Record<string, unknown>) ?? {};
  return {
    ...base,
    mcp_servers: {
      ...existingMcpServers,
      paperclip: {
        url: entry.url,
        startup_timeout_sec: 30,
        bearer_token: entry.bearerToken,
      },
    },
  };
}

export async function prepareCodexMcpConfig(input: {
  codexHome: string;
  ctx: AdapterExecutionContext;
  companyId: string;
  agentId: string;
  runId: string;
}): Promise<PreparedCodexMcpConfig | null> {
  const { codexHome, ctx, companyId, agentId, runId } = input;

  const configFilePath = path.join(codexHome, "config.toml");

  const result = await materializeMcpConfig({
    ctx,
    companyId,
    agentId,
    runId,
    targets: [
      {
        filePath: configFilePath,
        format: "toml",
        merge: buildCodexTomlEntry,
      },
    ],
  });

  if (!result) return null;

  return {
    configFilePath,
    apiKeyId: result.apiKeyId,
    expiresAt: result.expiresAt,
  };
}
