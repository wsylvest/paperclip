import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareMcpConfig } from "./mcp-config.js";

const FAKE_KEY = {
  id: "fake-id",
  plaintext: "pck_test_xxx",
  expiresAt: new Date(Date.now() + 3600_000),
};

function fakeMintKey() {
  return Promise.resolve(FAKE_KEY);
}

function silentLog() {
  return Promise.resolve();
}

describe("prepareMcpConfig", () => {
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-mcp-config-test-"));
    cleanupDirs.push(dir);
    return dir;
  }

  function makeInput(overrides: {
    seedDir?: string | null;
    workspaceCwd?: string;
    seedDirExists?: boolean;
  }) {
    return {
      seedDir: overrides.seedDir ?? null,
      workspaceCwd: overrides.workspaceCwd ?? "/nonexistent-workspace",
      companyId: "company-123",
      agentId: "agent-456",
      runId: "run-789",
      paperclipBaseUrl: "http://localhost:3100",
      mintKey: fakeMintKey,
      onLog: silentLog,
    };
  }

  it("returns null when workspace does not exist and seedDir is null", async () => {
    const result = await prepareMcpConfig(makeInput({ seedDir: null, workspaceCwd: "/nonexistent-workspace-xyz" }));
    expect(result).toBeNull();
  });

  it("writes only project file when seedDir is null and workspace exists", async () => {
    const workspaceCwd = await makeTmpDir();
    const result = await prepareMcpConfig(makeInput({ seedDir: null, workspaceCwd }));

    expect(result).not.toBeNull();
    expect(result?.seedFilePath).toBe("");
    expect(result?.projectFilePath).toBe(path.join(workspaceCwd, ".mcp.json"));
    expect(result?.apiKeyId).toBe("fake-id");

    const raw = await fs.readFile(path.join(workspaceCwd, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.paperclip).toBeDefined();
    expect(parsed.mcpServers.paperclip.type).toBe("http");
    expect(parsed.mcpServers.paperclip.url).toBe(
      "http://localhost:3100/api/companies/company-123/mcp/rpc",
    );
    expect(parsed.mcpServers.paperclip.headers.Authorization).toBe("Bearer pck_test_xxx");
  });

  it("writes both project and seed files when seedDir is provided", async () => {
    const workspaceCwd = await makeTmpDir();
    const seedDir = await makeTmpDir();

    const result = await prepareMcpConfig(makeInput({ seedDir, workspaceCwd }));

    expect(result).not.toBeNull();
    expect(result?.seedFilePath).toBe(path.join(seedDir, ".mcp.json"));
    expect(result?.projectFilePath).toBe(path.join(workspaceCwd, ".mcp.json"));

    for (const filePath of [result!.projectFilePath, result!.seedFilePath]) {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed.mcpServers.paperclip).toBeDefined();
      expect(parsed.mcpServers.paperclip.url).toContain("company-123");
    }
  });

  it("merges with existing mcpServers without removing user-managed entries", async () => {
    const workspaceCwd = await makeTmpDir();
    const existingConfig = {
      mcpServers: {
        foo: {
          type: "http",
          url: "https://foo.example.com",
        },
      },
    };
    await fs.writeFile(
      path.join(workspaceCwd, ".mcp.json"),
      JSON.stringify(existingConfig),
      "utf-8",
    );

    await prepareMcpConfig(makeInput({ seedDir: null, workspaceCwd }));

    const raw = await fs.readFile(path.join(workspaceCwd, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.foo).toBeDefined();
    expect(parsed.mcpServers.paperclip).toBeDefined();
  });

  it("overwrites existing paperclip entry with new token", async () => {
    const workspaceCwd = await makeTmpDir();
    const staleConfig = {
      mcpServers: {
        paperclip: {
          type: "http",
          url: "http://localhost:3100/api/companies/old-company/mcp/rpc",
          headers: { Authorization: "Bearer old_token" },
        },
      },
    };
    await fs.writeFile(
      path.join(workspaceCwd, ".mcp.json"),
      JSON.stringify(staleConfig),
      "utf-8",
    );

    await prepareMcpConfig(makeInput({ seedDir: null, workspaceCwd }));

    const raw = await fs.readFile(path.join(workspaceCwd, ".mcp.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.paperclip.headers.Authorization).toBe("Bearer pck_test_xxx");
    expect(parsed.mcpServers.paperclip.url).toContain("company-123");
    // Ensure no duplicate key named "paperclip" in the raw JSON
    const matches = (raw.match(/"paperclip"/g) ?? []).length;
    expect(matches).toBe(1);
  });

  it("does not leave tmp files behind after a successful write", async () => {
    const workspaceCwd = await makeTmpDir();

    await prepareMcpConfig(makeInput({ seedDir: null, workspaceCwd }));

    const files = await fs.readdir(workspaceCwd);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
    // The real .mcp.json is present
    expect(files).toContain(".mcp.json");
  });
});
