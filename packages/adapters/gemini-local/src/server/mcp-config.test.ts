import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareGeminiMcpConfig } from "./mcp-config.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const FAKE_KEY = {
  id: "gemini-key-id",
  plaintext: "pck_gemini_xxx",
  expiresAt: new Date(Date.now() + 3_600_000),
};

function makeCtx(override: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "test", adapterType: "gemini", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    mintMcpSessionKey: () => Promise.resolve(FAKE_KEY),
    paperclipBaseUrl: "http://localhost:3100",
    ...override,
  } as unknown as AdapterExecutionContext;
}

describe("prepareGeminiMcpConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pctest-gemini-mcp-"));
    cleanupDirs.push(dir);
    return dir;
  }

  it("returns null when mintMcpSessionKey is absent", async () => {
    const dir = await makeTmpDir();
    const result = await prepareGeminiMcpConfig({
      workspaceCwd: dir,
      ctx: makeCtx({ mintMcpSessionKey: undefined }),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(result).toBeNull();
  });

  it("writes .gemini/settings.json with httpUrl format and correct entry", async () => {
    const dir = await makeTmpDir();
    const result = await prepareGeminiMcpConfig({
      workspaceCwd: dir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(result).not.toBeNull();
    expect(result?.projectFilePath).toBe(path.join(dir, ".gemini", "settings.json"));
    expect(result?.seedFilePath).toBe("");
    expect(result?.apiKeyId).toBe("gemini-key-id");

    const parsed = JSON.parse(await fs.readFile(result!.projectFilePath, "utf-8"));
    // Gemini uses httpUrl, not url, and no type discriminant
    expect(parsed.mcpServers.paperclip.httpUrl).toBe(
      "http://localhost:3100/api/companies/company-1/mcp/rpc",
    );
    expect(parsed.mcpServers.paperclip.headers.Authorization).toBe("Bearer pck_gemini_xxx");
    // Must NOT have a type field
    expect(parsed.mcpServers.paperclip.type).toBeUndefined();
  });

  it("writes both project and seed files when seedDir is provided", async () => {
    const projectDir = await makeTmpDir();
    const seedDir = await makeTmpDir();

    const result = await prepareGeminiMcpConfig({
      workspaceCwd: projectDir,
      seedDir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(result?.projectFilePath).toBe(path.join(projectDir, ".gemini", "settings.json"));
    expect(result?.seedFilePath).toBe(path.join(seedDir, ".gemini", "settings.json"));

    for (const f of [result!.projectFilePath, result!.seedFilePath]) {
      const parsed = JSON.parse(await fs.readFile(f, "utf-8"));
      expect(parsed.mcpServers.paperclip.httpUrl).toContain("company-1");
    }
  });

  it("preserves unrelated settings.json keys when merging", async () => {
    const dir = await makeTmpDir();
    const geminiDir = path.join(dir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(
      path.join(geminiDir, "settings.json"),
      JSON.stringify({ theme: "dark", telemetry: false }),
      "utf-8",
    );

    await prepareGeminiMcpConfig({
      workspaceCwd: dir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    const parsed = JSON.parse(
      await fs.readFile(path.join(geminiDir, "settings.json"), "utf-8"),
    );
    // Pre-existing keys must survive
    expect(parsed.theme).toBe("dark");
    expect(parsed.telemetry).toBe(false);
    expect(parsed.mcpServers.paperclip).toBeDefined();
  });
});
