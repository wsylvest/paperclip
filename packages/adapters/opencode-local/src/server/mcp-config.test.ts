import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOpenCodeMcpConfig } from "./mcp-config.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const FAKE_KEY = {
  id: "opencode-key-id",
  plaintext: "pck_opencode_xxx",
  expiresAt: new Date(Date.now() + 3_600_000),
};

function makeCtx(override: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "test", adapterType: "opencode", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    mintMcpSessionKey: () => Promise.resolve(FAKE_KEY),
    paperclipBaseUrl: "http://localhost:3100",
    ...override,
  } as unknown as AdapterExecutionContext;
}

describe("prepareOpenCodeMcpConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pctest-opencode-mcp-"));
    cleanupDirs.push(dir);
    return dir;
  }

  it("returns null when mintMcpSessionKey is absent", async () => {
    const dir = await makeTmpDir();
    const result = await prepareOpenCodeMcpConfig({
      xdgConfigHome: dir,
      ctx: makeCtx({ mintMcpSessionKey: undefined }),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(result).toBeNull();
  });

  it("writes opencode/opencode.json with type=remote and correct entry", async () => {
    const dir = await makeTmpDir();
    const result = await prepareOpenCodeMcpConfig({
      xdgConfigHome: dir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    expect(result).not.toBeNull();
    expect(result?.configFilePath).toBe(path.join(dir, "opencode", "opencode.json"));
    expect(result?.apiKeyId).toBe("opencode-key-id");

    const parsed = JSON.parse(await fs.readFile(result!.configFilePath, "utf-8"));
    const entry = parsed.mcp.paperclip;
    expect(entry.type).toBe("remote");
    expect(entry.url).toBe("http://localhost:3100/api/companies/company-1/mcp/rpc");
    expect(entry.enabled).toBe(true);
    expect(entry.oauth).toBe(false);
    expect(entry.headers.Authorization).toBe("Bearer pck_opencode_xxx");
  });

  it("preserves existing opencode.json keys when merging", async () => {
    const dir = await makeTmpDir();
    const opencodeDir = path.join(dir, "opencode");
    await fs.mkdir(opencodeDir, { recursive: true });
    await fs.writeFile(
      path.join(opencodeDir, "opencode.json"),
      JSON.stringify({ permission: { external_directory: "allow" }, mcp: { other: { type: "remote", url: "https://other.example.com" } } }),
      "utf-8",
    );

    await prepareOpenCodeMcpConfig({
      xdgConfigHome: dir,
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
    });

    const parsed = JSON.parse(
      await fs.readFile(path.join(opencodeDir, "opencode.json"), "utf-8"),
    );
    // Existing keys preserved
    expect(parsed.permission.external_directory).toBe("allow");
    expect(parsed.mcp.other).toBeDefined();
    // New entry added
    expect(parsed.mcp.paperclip).toBeDefined();
  });
});
