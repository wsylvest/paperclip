// Kimi Code reads MCP server configuration from ~/.kimi/mcp.json.
// The JSON shape is documented as identical to Claude Code's .mcp.json:
//   { "mcpServers": { "<name>": { "url": "...", "headers": { ... } } } }
// HTTP servers use url + headers; stdio servers use command + args + env.
//
// ASSUMPTION: Kimi reads a project-local .mcp.json the same way Claude Code
// does. If this is not confirmed, only the seed-dir file (~/.kimi/mcp.json)
// path matters, but we write the project file as well for compatibility.
// Verify at https://kimi.ai/code/docs if behavior changes.

import path from "node:path";
import { materializeMcpConfig } from "@paperclipai/adapter-utils/mcp-config";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

export interface PreparedKimiMcpConfig {
  /** Path of the seed-scope .mcp.json (lives inside the seed dir). */
  seedFilePath: string;
  /** Path of the project-scope .mcp.json (lives at <workspaceCwd>/.mcp.json). */
  projectFilePath: string;
  /** The minted key id, so the caller can revoke after the run. */
  apiKeyId: string;
  /** ISO timestamp when the key expires. */
  expiresAt: string;
}

function buildKimiJsonEntry(
  existing: Record<string, unknown> | null,
  paperclipEntry: { url: string; bearerToken: string; runId: string },
): Record<string, unknown> {
  const base = existing ?? {};
  const existingServers = (base.mcpServers as Record<string, unknown>) ?? {};
  return {
    ...base,
    mcpServers: {
      ...existingServers,
      paperclip: {
        type: "http",
        url: paperclipEntry.url,
        headers: {
          Authorization: `Bearer ${paperclipEntry.bearerToken}`,
          "X-Paperclip-Run-Id": paperclipEntry.runId,
        },
      },
    },
  };
}

export async function prepareMcpConfig(input: {
  seedDir: string | null;
  workspaceCwd: string;
  companyId: string;
  agentId: string;
  runId: string;
  paperclipBaseUrl: string;
  mintKey: (opts: {
    companyId: string;
    agentId: string;
    runId: string;
  }) => Promise<{ id: string; plaintext: string; expiresAt: Date }>;
  onLog: (stream: "stdout" | "stderr", message: string) => Promise<void>;
}): Promise<PreparedKimiMcpConfig | null> {
  const { seedDir, workspaceCwd, companyId, agentId, runId, paperclipBaseUrl, mintKey, onLog } =
    input;

  const ctx = {
    runId,
    agent: { id: agentId, companyId, name: "", adapterType: null, adapterConfig: null },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog,
    mintMcpSessionKey: mintKey,
    paperclipBaseUrl,
  } as unknown as AdapterExecutionContext;

  const projectFilePath = path.join(workspaceCwd, ".mcp.json");
  const seedFilePath = seedDir ? path.join(seedDir, ".mcp.json") : "";

  const targets = [
    {
      filePath: projectFilePath,
      format: "json" as const,
      merge: buildKimiJsonEntry,
    },
    ...(seedDir
      ? [
          {
            filePath: seedFilePath,
            format: "json" as const,
            merge: buildKimiJsonEntry,
          },
        ]
      : []),
  ];

  const fs = await import("node:fs/promises");
  const workspaceExists = await fs.access(workspaceCwd).then(() => true).catch(() => false);
  if (!seedDir && !workspaceExists) {
    await onLog(
      "stderr",
      `[paperclip] MCP config: workspace dir "${workspaceCwd}" does not exist and no seed dir; skipping .mcp.json materialization.\n`,
    );
    return null;
  }

  if (!workspaceExists) {
    await fs.mkdir(workspaceCwd, { recursive: true });
  }

  const result = await materializeMcpConfig({ ctx, companyId, agentId, runId, targets });
  if (!result) return null;

  return {
    seedFilePath,
    projectFilePath,
    apiKeyId: result.apiKeyId,
    expiresAt: result.expiresAt,
  };
}
