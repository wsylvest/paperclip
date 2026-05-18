// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  McpHealthCheckResult,
  McpInvocation,
  McpServer,
  McpServerGrant,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mcp } from "./Mcp";

const mockMcpApi = vi.hoisted(() => ({
  listServers: vi.fn(),
  getServer: vi.fn(),
  createServer: vi.fn(),
  updateServer: vi.fn(),
  deleteServer: vi.fn(),
  probeServer: vi.fn(),
  listGrants: vi.fn(),
  createGrant: vi.fn(),
  deleteGrant: vi.fn(),
  listInvocations: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockRoutinesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("../api/mcp", () => ({ mcpApi: mockMcpApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/routines", () => ({ routinesApi: mockRoutinesApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: "srv-1",
    companyId: "company-1",
    name: "linear-mcp",
    description: "Linear MCP server",
    transport: "streamable_http",
    endpoint: "https://example.com/mcp",
    authType: "none",
    authSecretRef: null,
    capabilities: null,
    allowlist: null,
    healthStatus: "healthy",
    healthCheckedAt: new Date("2026-05-12T00:00:00Z"),
    consecutiveFails: 0,
    surchargeMicrocents: 0,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Mcp page", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    Object.values(mockMcpApi).forEach((fn) => fn.mockReset());
    mockAgentsApi.list.mockReset();
    mockProjectsApi.list.mockReset();
    mockRoutinesApi.list.mockReset();
    mockSecretsApi.list.mockReset();
    mockPushToast.mockReset();

    mockMcpApi.listServers.mockResolvedValue([]);
    mockMcpApi.listGrants.mockResolvedValue([]);
    mockMcpApi.listInvocations.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockRoutinesApi.list.mockResolvedValue([]);
    mockSecretsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Mcp />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
  }

  it("renders the empty state when no servers exist", async () => {
    await render();
    expect(container.textContent).toContain("No MCP servers registered yet");
  });

  it("renders the server list with the health badge from the API response", async () => {
    mockMcpApi.listServers.mockResolvedValue([
      makeServer({ id: "srv-1", name: "linear-mcp", healthStatus: "degraded", consecutiveFails: 3 }),
    ]);
    await render();
    expect(container.textContent).toContain("linear-mcp");
    expect(container.textContent).toContain("degraded");
    expect(container.textContent).toContain("3 fails");
  });

  it("opens the register server dialog when the button is clicked", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='mcp-register-button']",
    );
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    await flush();
    expect(document.body.textContent).toContain("Register MCP server");
  });

  it("submits the form and calls mcpApi.createServer", async () => {
    mockMcpApi.createServer.mockResolvedValue(makeServer({ id: "srv-new", name: "newserver" }));
    await render();
    const button = container.querySelector<HTMLButtonElement>(
      "[data-testid='mcp-register-button']",
    );
    await act(async () => {
      button!.click();
    });
    await flush();

    const nameInput = document.body.querySelector<HTMLInputElement>(
      "[data-testid='mcp-form-name']",
    );
    const endpointInput = document.body.querySelector<HTMLInputElement>(
      "[data-testid='mcp-form-endpoint']",
    );
    expect(nameInput).not.toBeNull();
    expect(endpointInput).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
        .set!;
      setter.call(nameInput, "newserver");
      nameInput!.dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(endpointInput, "https://example.com/mcp");
      endpointInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    const submit = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='mcp-form-submit']",
    );
    await act(async () => {
      submit!.click();
    });
    await flush();
    await flush();

    expect(mockMcpApi.createServer).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        name: "newserver",
        endpoint: "https://example.com/mcp",
        transport: "streamable_http",
        authType: "none",
      }),
    );
  });

  it("calls mcpApi.probeServer when the probe button is clicked", async () => {
    mockMcpApi.listServers.mockResolvedValueOnce([
      makeServer({ id: "srv-1", healthStatus: "unknown" }),
    ]);
    const probeResult: McpHealthCheckResult = {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      consecutiveFails: 0,
    };
    mockMcpApi.probeServer.mockResolvedValue(probeResult);
    mockMcpApi.listServers.mockResolvedValueOnce([
      makeServer({ id: "srv-1", healthStatus: "healthy" }),
    ]);

    await render();
    const probe = container.querySelector<HTMLButtonElement>("[data-testid='mcp-probe-srv-1']");
    expect(probe).not.toBeNull();
    await act(async () => {
      probe!.click();
    });
    await flush();
    await flush();
    expect(mockMcpApi.probeServer).toHaveBeenCalledWith("company-1", "srv-1");
  });

  it("requires confirmation before deleting and removes the row on success", async () => {
    mockMcpApi.listServers.mockResolvedValueOnce([makeServer({ id: "srv-1" })]);
    mockMcpApi.deleteServer.mockResolvedValue(undefined);
    mockMcpApi.listServers.mockResolvedValueOnce([]);

    await render();
    expect(container.textContent).toContain("linear-mcp");
    const del = container.querySelector<HTMLButtonElement>("[data-testid='mcp-delete-srv-1']");
    await act(async () => {
      del!.click();
    });
    await flush();
    expect(document.body.textContent).toContain("Delete MCP server");

    const confirm = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='mcp-confirm-delete']",
    );
    await act(async () => {
      confirm!.click();
    });
    await flush();
    await flush();
    expect(mockMcpApi.deleteServer).toHaveBeenCalledWith("company-1", "srv-1");
  });

  it("loads grants and invocations when a row is expanded", async () => {
    mockMcpApi.listServers.mockResolvedValue([makeServer({ id: "srv-1" })]);
    const grant: McpServerGrant = {
      id: "grant-1",
      companyId: "company-1",
      mcpServerId: "srv-1",
      principalType: "company",
      principalId: null,
      toolAllowlist: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockMcpApi.listGrants.mockResolvedValue([grant]);
    const invocation: McpInvocation = {
      id: "inv-1",
      companyId: "company-1",
      runId: null,
      agentId: null,
      mcpServerId: "srv-1",
      toolName: "search",
      requestPayloadHash: null,
      responsePayloadHash: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "succeeded",
      errorClass: null,
      costMicrocents: 12345,
      approvalId: null,
    };
    mockMcpApi.listInvocations.mockResolvedValue([invocation]);

    await render();
    const row = container.querySelector<HTMLTableRowElement>("[data-testid='mcp-row-srv-1']");
    expect(row).not.toBeNull();
    await act(async () => {
      row!.click();
    });
    await flush();
    await flush();
    expect(mockMcpApi.listGrants).toHaveBeenCalledWith("company-1", "srv-1");
    expect(container.textContent).toContain("Whole company");
  });

  it("adds a grant via mcpApi.createGrant and updates the list", async () => {
    mockMcpApi.listServers.mockResolvedValue([makeServer({ id: "srv-1" })]);
    mockMcpApi.listGrants.mockResolvedValueOnce([]);
    const newGrant: McpServerGrant = {
      id: "grant-new",
      companyId: "company-1",
      mcpServerId: "srv-1",
      principalType: "company",
      principalId: null,
      toolAllowlist: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockMcpApi.createGrant.mockResolvedValue(newGrant);
    mockMcpApi.listGrants.mockResolvedValueOnce([newGrant]);

    await render();
    const row = container.querySelector<HTMLTableRowElement>("[data-testid='mcp-row-srv-1']");
    await act(async () => {
      row!.click();
    });
    await flush();

    const addBtn = container.querySelector<HTMLButtonElement>(
      "[data-testid='mcp-add-grant-button']",
    );
    expect(addBtn).not.toBeNull();
    await act(async () => {
      addBtn!.click();
    });
    await flush();
    const submit = document.body.querySelector<HTMLButtonElement>(
      "[data-testid='mcp-grant-submit']",
    );
    expect(submit).not.toBeNull();
    await act(async () => {
      submit!.click();
    });
    await flush();
    await flush();

    expect(mockMcpApi.createGrant).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        mcpServerId: "srv-1",
        principalType: "company",
        principalId: null,
      }),
    );
  });
});
