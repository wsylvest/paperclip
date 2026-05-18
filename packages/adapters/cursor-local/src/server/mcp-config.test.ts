import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCursorMcpConfig } from "./mcp-config.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const FAKE_KEY = {
  id: "cursor-key-id",
  plaintext: "pck_cursor_xxx",
  expiresAt: new Date(Date.now() + 3_600_000),
};

function makeCtx(override: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "test", adapterType: "cursor", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    mintMcpSessionKey: () => Promise.resolve(FAKE_KEY),
    paperclipBaseUrl: "http://localhost:3100",
    ...override,
  } as unknown as AdapterExecutionContext;
}

describe("prepareCursorMcpConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pctest-cursor-mcp-"));
    cleanupDirs.push(dir);
    return dir;
  }

  it("returns null when mintMcpSessionKey is absent", async () => {
    const dir = await makeTmpDir();
    const result = await prepareCursorMcpConfig({
      workspaceCwd: dir,
      ctx: makeCtx({ mintMcpSessionKey: undefined }),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(result).toBeNull();
  });

  it("writes .cursor/mcp.json with correct path and paperclip entry", async () => {
    const dir = await makeTmpDir();
    const result = await prepareCursorMcpConfig({
      workspaceCwd: dir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(result).not.toBeNull();
    expect(result?.projectFilePath).toBe(path.join(dir, ".cursor", "mcp.json"));
    expect(result?.apiKeyId).toBe("cursor-key-id");

    const raw = await fs.readFile(result!.projectFilePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.paperclip.type).toBe("http");
    expect(parsed.mcpServers.paperclip.url).toBe(
      "http://localhost:3100/api/companies/company-1/mcp/rpc",
    );
    expect(parsed.mcpServers.paperclip.headers.Authorization).toBe("Bearer pck_cursor_xxx");
  });

  it("merges with existing .cursor/mcp.json without losing user-managed entries", async () => {
    const dir = await makeTmpDir();
    const cursorDir = path.join(dir, ".cursor");
    await fs.mkdir(cursorDir, { recursive: true });
    await fs.writeFile(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify({ mcpServers: { myOtherServer: { type: "http", url: "https://other.dev" } } }),
      "utf-8",
    );

    await prepareCursorMcpConfig({
      workspaceCwd: dir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    const parsed = JSON.parse(await fs.readFile(path.join(cursorDir, "mcp.json"), "utf-8"));
    expect(parsed.mcpServers.myOtherServer).toBeDefined();
    expect(parsed.mcpServers.paperclip).toBeDefined();
  });
});
