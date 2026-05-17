import fs from "node:fs/promises";
import path from "node:path";

export interface PreparedMcpConfig {
  /** Path of the seed-scope .mcp.json (lives inside the seed dir). */
  seedFilePath: string;
  /** Path of the project-scope .mcp.json (lives at <workspaceCwd>/.mcp.json). */
  projectFilePath: string;
  /** The minted key id, so the caller can revoke after the run. */
  apiKeyId: string;
  /** ISO timestamp when the key expires. */
  expiresAt: string;
}

interface McpServersMap {
  [name: string]: {
    type: string;
    url: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  };
}

interface McpConfigFile {
  mcpServers?: McpServersMap;
  [key: string]: unknown;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function readExistingMcpConfig(filePath: string): Promise<McpConfigFile> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as McpConfigFile;
    }
  } catch {
    // Missing or malformed file — start fresh.
  }
  return {};
}

function buildMcpConfigContent(
  existing: McpConfigFile,
  paperclipEntry: McpServersMap["paperclip"],
): McpConfigFile {
  const existingServers = existing.mcpServers ?? {};
  return {
    ...existing,
    mcpServers: {
      ...existingServers,
      paperclip: paperclipEntry,
    },
  };
}

async function writeAtomically(filePath: string, content: McpConfigFile): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  const serialized = JSON.stringify(content, null, 2) + "\n";
  await fs.writeFile(tmpPath, serialized, "utf-8");
  await fs.rename(tmpPath, filePath);
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
}): Promise<PreparedMcpConfig | null> {
  const { seedDir, workspaceCwd, companyId, agentId, runId, paperclipBaseUrl, mintKey, onLog } =
    input;

  const workspaceExists = await pathExists(workspaceCwd);
  if (!seedDir && !workspaceExists) {
    await onLog(
      "stderr",
      `[paperclip] MCP config: workspace dir "${workspaceCwd}" does not exist and no seed dir; skipping .mcp.json materialization.\n`,
    );
    return null;
  }

  let minted: { id: string; plaintext: string; expiresAt: Date };
  try {
    minted = await mintKey({ companyId, agentId, runId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip] MCP config: failed to mint MCP gateway session key: ${reason}. Skipping .mcp.json materialization.\n`,
    );
    return null;
  }

  const paperclipEntry = {
    type: "http",
    url: `${paperclipBaseUrl}/api/companies/${companyId}/mcp/rpc`,
    headers: {
      Authorization: `Bearer ${minted.plaintext}`,
    },
  };

  const projectFilePath = path.join(workspaceCwd, ".mcp.json");
  const existing = await readExistingMcpConfig(projectFilePath);
  const merged = buildMcpConfigContent(existing, paperclipEntry);

  if (!workspaceExists) {
    await fs.mkdir(workspaceCwd, { recursive: true });
  }
  await writeAtomically(projectFilePath, merged);

  let seedFilePath = "";
  if (seedDir) {
    seedFilePath = path.join(seedDir, ".mcp.json");
    const existingSeed = await readExistingMcpConfig(seedFilePath);
    const mergedSeed = buildMcpConfigContent(existingSeed, paperclipEntry);
    await writeAtomically(seedFilePath, mergedSeed);
  }

  await onLog(
    "stdout",
    `[paperclip] MCP config: wrote .mcp.json with Paperclip gateway entry (keyId=${minted.id}, expires=${minted.expiresAt.toISOString()}).\n`,
  );

  return {
    seedFilePath,
    projectFilePath,
    apiKeyId: minted.id,
    expiresAt: minted.expiresAt.toISOString(),
  };
}
