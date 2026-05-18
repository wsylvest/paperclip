import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { mcpApi } from "./mcp";

describe("mcpApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
    mockApi.delete.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({});
    mockApi.patch.mockResolvedValue({});
    mockApi.delete.mockResolvedValue(undefined);
  });

  it("listServers calls the company-scoped servers endpoint", async () => {
    await mcpApi.listServers("co-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/co-1/mcp/servers");
  });

  it("getServer calls the server detail endpoint", async () => {
    await mcpApi.getServer("co-1", "srv-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/co-1/mcp/servers/srv-1");
  });

  it("createServer POSTs the input payload", async () => {
    await mcpApi.createServer("co-1", {
      name: "linear",
      transport: "streamable_http",
      endpoint: "https://example.com/mcp",
      authType: "none",
    });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/co-1/mcp/servers",
      expect.objectContaining({ name: "linear", transport: "streamable_http" }),
    );
  });

  it("updateServer PATCHes the server resource", async () => {
    await mcpApi.updateServer("co-1", "srv-1", { name: "renamed" });
    expect(mockApi.patch).toHaveBeenCalledWith(
      "/companies/co-1/mcp/servers/srv-1",
      { name: "renamed" },
    );
  });

  it("deleteServer DELETEs the server resource", async () => {
    await mcpApi.deleteServer("co-1", "srv-1");
    expect(mockApi.delete).toHaveBeenCalledWith("/companies/co-1/mcp/servers/srv-1");
  });

  it("probeServer POSTs to the probe endpoint with empty body", async () => {
    await mcpApi.probeServer("co-1", "srv-1");
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/co-1/mcp/servers/srv-1/probe",
      {},
    );
  });

  it("listGrants includes serverId in the query when provided", async () => {
    await mcpApi.listGrants("co-1", "srv-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/co-1/mcp/grants?serverId=srv-1");
  });

  it("listGrants omits the serverId query when undefined", async () => {
    await mcpApi.listGrants("co-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/co-1/mcp/grants");
  });

  it("createGrant POSTs to the grants endpoint", async () => {
    await mcpApi.createGrant("co-1", {
      mcpServerId: "srv-1",
      principalType: "company",
      principalId: null,
      toolAllowlist: null,
    });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/co-1/mcp/grants",
      expect.objectContaining({ mcpServerId: "srv-1", principalType: "company" }),
    );
  });

  it("deleteGrant DELETEs the grant resource", async () => {
    await mcpApi.deleteGrant("co-1", "grant-1");
    expect(mockApi.delete).toHaveBeenCalledWith("/companies/co-1/mcp/grants/grant-1");
  });

  it("listInvocations passes all options as query params", async () => {
    await mcpApi.listInvocations("co-1", {
      serverId: "srv-1",
      runId: "run-1",
      limit: 25,
      beforeId: "inv-9",
    });
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/co-1/mcp/invocations?runId=run-1&serverId=srv-1&limit=25&beforeId=inv-9",
    );
  });

  it("listInvocations omits the query string when no options are given", async () => {
    await mcpApi.listInvocations("co-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/co-1/mcp/invocations");
  });
});
