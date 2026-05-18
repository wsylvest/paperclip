import path from "node:path";
import { materializeMcpConfig } from "@paperclipai/adapter-utils/mcp-config";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface PreparedOpenCodeMcpConfig {
  configFilePath: string;
  apiKeyId: string;
  expiresAt: string;
}

/**
 * OpenCode reads MCP servers from the `mcp` key inside its opencode.json
 * config file (located at <XDG_CONFIG_HOME>/opencode/opencode.json).
 *
 * Remote MCP servers use `type: "remote"` with a `url` and `headers` map.
 * We also set `oauth: false` to prevent opencode from attempting OAuth
 * discovery and force it to use our pre-supplied bearer token.
 *
 * The runtime XDG_CONFIG_HOME used here is the tmp directory prepared by
 * prepareOpenCodeRuntimeConfig (which may have copied the user's existing
 * config already). If skipPermissions was false (no runtime config was
 * created), the caller passes the source config dir directly.
 */
function buildOpenCodeJsonEntry(
  existing: Record<string, unknown> | null,
  entry: { url: string; bearerToken: string },
): Record<string, unknown> {
  const base = existing ?? {};
  const existingMcp = (base.mcp as Record<string, unknown>) ?? {};
  return {
    ...base,
    mcp: {
      ...existingMcp,
      paperclip: {
        type: "remote",
        url: entry.url,
        enabled: true,
        oauth: false,
        headers: {
          Authorization: `Bearer ${entry.bearerToken}`,
        },
      },
    },
  };
}

export async function prepareOpenCodeMcpConfig(input: {
  /**
   * The directory that will be used as XDG_CONFIG_HOME. The opencode.json
   * file will be written at <xdgConfigHome>/opencode/opencode.json.
   */
  xdgConfigHome: string;
  ctx: AdapterExecutionContext;
  companyId: string;
  agentId: string;
  runId: string;
}): Promise<PreparedOpenCodeMcpConfig | null> {
  const { xdgConfigHome, ctx, companyId, agentId, runId } = input;

  const configFilePath = path.join(xdgConfigHome, "opencode", "opencode.json");

  const result = await materializeMcpConfig({
    ctx,
    companyId,
    agentId,
    runId,
    targets: [
      {
        filePath: configFilePath,
        format: "json",
        merge: buildOpenCodeJsonEntry,
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
