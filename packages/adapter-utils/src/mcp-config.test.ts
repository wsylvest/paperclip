import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TOML from "@iarna/toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeMcpConfig } from "./mcp-config.js";
import type { AdapterExecutionContext } from "./types.js";

const FAKE_KEY = {
  id: "fake-key-id",
  plaintext: "pck_test_abc",
  expiresAt: new Date(Date.now() + 3_600_000),
};

function fakeMintKey() {
  return Promise.resolve(FAKE_KEY);
}

function makeCtx(override: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "test", adapterType: "test", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {},
    context: {},
    onLog: async () => {},
    mintMcpSessionKey: fakeMintKey,
    paperclipBaseUrl: "http://localhost:3100",
    ...override,
  } as unknown as AdapterExecutionContext;
}

const PAPERCLIP_URL = "http://localhost:3100/api/companies/company-1/mcp/rpc";

function jsonMerge(
  existing: Record<string, unknown> | null,
  entry: { url: string; bearerToken: string; runId: string },
): Record<string, unknown> {
  const existing2 = existing ?? {};
  const servers = (existing2.mcpServers as Record<string, unknown>) ?? {};
  return {
    ...existing2,
    mcpServers: {
      ...servers,
      paperclip: {
        type: "http",
        url: entry.url,
        headers: { Authorization: `Bearer ${entry.bearerToken}` },
      },
    },
  };
}

function tomlMerge(
  existing: Record<string, unknown> | null,
  entry: { url: string; bearerToken: string; runId: string },
): Record<string, unknown> {
  const base = existing ?? {};
  const mcpServers = (base.mcp_servers as Record<string, unknown>) ?? {};
  return {
    ...base,
    mcp_servers: {
      ...mcpServers,
      paperclip: {
        url: entry.url,
        bearer_token: entry.bearerToken,
        startup_timeout_sec: 30,
      },
    },
  };
}

describe("materializeMcpConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pctest-mcp-"));
    cleanupDirs.push(dir);
    return dir;
  }

  it("returns null when mintMcpSessionKey is missing from ctx", async () => {
    const dir = await makeTmpDir();
    const result = await materializeMcpConfig({
      ctx: makeCtx({ mintMcpSessionKey: undefined }),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      targets: [{ filePath: path.join(dir, ".mcp.json"), format: "json", merge: jsonMerge }],
    });
    expect(result).toBeNull();
  });

  it("returns null when paperclipBaseUrl is missing from ctx", async () => {
    const dir = await makeTmpDir();
    const result = await materializeMcpConfig({
      ctx: makeCtx({ paperclipBaseUrl: undefined }),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      targets: [{ filePath: path.join(dir, ".mcp.json"), format: "json", merge: jsonMerge }],
    });
    expect(result).toBeNull();
  });

  it("writes two JSON targets fresh — both receive the paperclip entry", async () => {
    const dir1 = await makeTmpDir();
    const dir2 = await makeTmpDir();
    const file1 = path.join(dir1, ".mcp.json");
    const file2 = path.join(dir2, ".mcp.json");

    const result = await materializeMcpConfig({
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      targets: [
        { filePath: file1, format: "json", merge: jsonMerge },
        { filePath: file2, format: "json", merge: jsonMerge },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.filesWritten).toEqual([file1, file2]);
    expect(result?.apiKeyId).toBe("fake-key-id");

    for (const f of [file1, file2]) {
      const parsed = JSON.parse(await fs.readFile(f, "utf-8"));
      expect(parsed.mcpServers.paperclip.url).toBe(PAPERCLIP_URL);
      expect(parsed.mcpServers.paperclip.headers.Authorization).toBe("Bearer pck_test_abc");
    }
  });

  it("preserves unrelated existing JSON keys when merging", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, ".mcp.json");
    await fs.writeFile(
      file,
      JSON.stringify({ mcpServers: { other: { type: "http", url: "https://other.example.com" } } }),
      "utf-8",
    );

    await materializeMcpConfig({
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      targets: [{ filePath: file, format: "json", merge: jsonMerge }],
    });

    const parsed = JSON.parse(await fs.readFile(file, "utf-8"));
    expect(parsed.mcpServers.other).toBeDefined();
    expect(parsed.mcpServers.paperclip).toBeDefined();
  });

  it("preserves unrelated TOML sections when merging", async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, "config.toml");
    await fs.writeFile(
      file,
      TOML.stringify({ other_section: { key: "value" } } as TOML.JsonMap),
      "utf-8",
    );

    await materializeMcpConfig({
      ctx: makeCtx(),
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      targets: [{ filePath: file, format: "toml", merge: tomlMerge }],
    });

    const parsed = TOML.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    expect((parsed.other_section as Record<string, unknown>).key).toBe("value");
    const mcpServers = parsed.mcp_servers as Record<string, unknown>;
    expect(mcpServers.paperclip).toBeDefined();
    const entry = mcpServers.paperclip as Record<string, unknown>;
    expect(entry.url).toBe(PAPERCLIP_URL);
    expect(entry.bearer_token).toBe("pck_test_abc");
  });

  it("throws after all targets are attempted when one target write fails", async () => {
    const dir1 = await makeTmpDir();
    const dir2 = await makeTmpDir();
    const file1 = path.join(dir1, ".mcp.json");
    const file2 = path.join(dir2, ".mcp.json");

    // Make file2's parent read-only so rename will fail
    const file2Bad = path.join(dir2, "readonly-subdir", ".mcp.json");
    await fs.mkdir(path.join(dir2, "readonly-subdir"), { recursive: true });
    await fs.chmod(path.join(dir2, "readonly-subdir"), 0o444);

    let threw = false;
    try {
      await materializeMcpConfig({
        ctx: makeCtx(),
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        targets: [
          { filePath: file1, format: "json", merge: jsonMerge },
          { filePath: file2Bad, format: "json", merge: jsonMerge },
        ],
      });
    } catch {
      threw = true;
    } finally {
      // Restore permissions for cleanup
      await fs.chmod(path.join(dir2, "readonly-subdir"), 0o755).catch(() => undefined);
    }

    expect(threw).toBe(true);
    // file1 should still have been written despite the failure on file2Bad
    const parsed = JSON.parse(await fs.readFile(file1, "utf-8"));
    expect(parsed.mcpServers.paperclip).toBeDefined();
  });
});
