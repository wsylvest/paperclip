import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCodexMcpConfig } from "./mcp-config.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const FAKE_KEY = {
  id: "codex-key-id",
  plaintext: "pck_codex_xxx",
  expiresAt: new Date(Date.now() + 3_600_000),
};

function makeCtx(override: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "test", adapterType: "codex", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    mintMcpSessionKey: () => Promise.resolve(FAKE_KEY),
    paperclipBaseUrl: "http://localhost:3100",
    ...override,
  } as unknown as AdapterExecutionContext;
}

describe("prepareCodexMcpConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pctest-codex-mcp-"));
    cleanupDirs.push(dir);
    return dir;
  }

  it("returns null when mintMcpSessionKey is absent", async () => {
    const dir = await makeTmpDir();
    const result = await prepareCodexMcpConfig({
      codexHome: dir,
      ctx: makeCtx({ mintMcpSessionKey: undefined }),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(result).toBeNull();
  });

  it("writes config.toml at <codexHome>/config.toml with bearer_token", async () => {
    const dir = await makeTmpDir();
    const result = await prepareCodexMcpConfig({
      codexHome: dir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(result).not.toBeNull();
    expect(result?.configFilePath).toBe(path.join(dir, "config.toml"));
    expect(result?.apiKeyId).toBe("codex-key-id");

    const raw = await fs.readFile(result!.configFilePath, "utf-8");
    const parsed = TOML.parse(raw) as Record<string, unknown>;
    const mcpServers = parsed.mcp_servers as Record<string, unknown>;
    const entry = mcpServers.paperclip as Record<string, unknown>;
    expect(entry.url).toBe("http://localhost:3100/api/companies/company-1/mcp/rpc");
    expect(entry.bearer_token).toBe("pck_codex_xxx");
    expect(entry.startup_timeout_sec).toBe(30);
  });

  it("merges with existing config.toml without losing unrelated sections", async () => {
    const dir = await makeTmpDir();
    const existingToml = `[model]
provider = "openai"
name = "o4-mini"

[history]
max_entries = 100
`;
    await fs.writeFile(path.join(dir, "config.toml"), existingToml, "utf-8");

    await prepareCodexMcpConfig({
      codexHome: dir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    const raw = await fs.readFile(path.join(dir, "config.toml"), "utf-8");
    const parsed = TOML.parse(raw) as Record<string, unknown>;
    // Existing sections must survive
    const model = parsed.model as Record<string, unknown>;
    expect(model.provider).toBe("openai");
    expect(model.name).toBe("o4-mini");
    const history = parsed.history as Record<string, unknown>;
    expect(history.max_entries).toBe(100);
    // New section present
    const mcpServers = parsed.mcp_servers as Record<string, unknown>;
    expect(mcpServers.paperclip).toBeDefined();
  });
});
