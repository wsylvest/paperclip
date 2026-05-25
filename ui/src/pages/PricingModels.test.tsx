// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PricingModel } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PricingModels } from "./PricingModels";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockPricingApi = vi.hoisted(() => ({
  listModels: vi.fn(),
  createModel: vi.fn(),
  updateModel: vi.fn(),
  deactivateModel: vi.fn(),
  estimate: vi.fn(),
}));

const mockAddToast = vi.hoisted(() => vi.fn());

vi.mock("../api/pricing", () => ({ pricingApi: mockPricingApi }));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ addToast: mockAddToast }),
}));
vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => (
    <div data-testid="empty-state">{message}</div>
  ),
}));

function buildModel(overrides: Partial<PricingModel> = {}): PricingModel {
  return {
    id: "model-1",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    adapterType: null,
    inputCostMicrocentsPer1k: 300_000,
    cachedInputCostMicrocentsPer1k: 30_000,
    outputCostMicrocentsPer1k: 1_500_000,
    currency: "USD",
    effectiveFrom: "2024-01-01T00:00:00.000Z",
    effectiveTo: null,
    active: true,
    notes: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("PricingModels page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.resetAllMocks();
    mockPricingApi.listModels.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows empty state when no models exist", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(wrapper(<PricingModels />));
    });

    // Wait for query to resolve
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain("No pricing models");
    root.unmount();
  });

  it("renders a list of models when data is returned", async () => {
    mockPricingApi.listModels.mockResolvedValue([buildModel()]);
    const root = createRoot(container);

    await act(async () => {
      root.render(wrapper(<PricingModels />));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain("anthropic");
    expect(container.textContent).toContain("claude-sonnet-4-5");
    expect(container.textContent).toContain("Active");
    root.unmount();
  });

  it("shows Add model button", async () => {
    const root = createRoot(container);

    await act(async () => {
      root.render(wrapper(<PricingModels />));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain("Add model");
    root.unmount();
  });

  it("renders inactive models with Inactive label", async () => {
    mockPricingApi.listModels.mockResolvedValue([buildModel({ active: false })]);
    const root = createRoot(container);

    await act(async () => {
      root.render(wrapper(<PricingModels />));
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.textContent).toContain("Inactive");
    root.unmount();
  });
});
