import { beforeEach, describe, expect, it, vi } from "vitest";
import { deploymentService } from "../services/deployments.ts";

/**
 * Helper: creates a thenable object that resolves with `value`.
 * Drizzle query builders are thenables -- `.then(cb)` both chains
 * and triggers execution when consumed by `await` / `Promise.all`.
 */
function thenable<T>(value: T) {
  return {
    then: (resolve?: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
}

function createInsertStub(pendingInserts: unknown[][]) {
  const insertValues = vi.fn(() => ({
    returning: vi.fn(() => ({
      then: (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(pendingInserts.shift() ?? []).then(resolve, reject),
    })),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  return { insert, insertValues, pendingInserts };
}

function createUpdateStub(pendingUpdates: unknown[][]) {
  const returning = vi.fn(() => ({
    then: (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(pendingUpdates.shift() ?? []).then(resolve, reject),
  }));
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { update, set, where, returning, pendingUpdates };
}

function createSelectStub(pendingSelects: unknown[][]) {
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => thenable(pendingSelects.shift() ?? [])),
        orderBy: vi.fn(() => thenable(pendingSelects.shift() ?? [])),
      })),
    })),
  }));
  return { select, pendingSelects };
}

describe("deploymentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("inserts a deployment and returns the row", async () => {
      const insertedRow = {
        id: "dep-1",
        companyId: "company-1",
        issueId: null,
        agentId: null,
        workProductId: null,
        environment: "production",
        status: "pending",
        provider: "vercel",
        url: "https://example.com",
        commitSha: "abc123",
        healthCheckUrl: null,
        healthStatus: "unknown",
        createdAt: new Date(),
      };

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([insertedRow]);

      const db = { insert } as any;
      const svc = deploymentService(db);
      const result = await svc.create("company-1", {
        environment: "production",
        provider: "vercel",
        url: "https://example.com",
        commitSha: "abc123",
      });

      expect(result).toEqual(insertedRow);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          environment: "production",
          provider: "vercel",
          url: "https://example.com",
          commitSha: "abc123",
        }),
      );
    });

    it("defaults optional fields to null", async () => {
      const insertedRow = {
        id: "dep-2",
        companyId: "company-1",
        environment: "staging",
        issueId: null,
        agentId: null,
        provider: null,
        url: null,
        commitSha: null,
      };

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([insertedRow]);

      const db = { insert } as any;
      const svc = deploymentService(db);
      await svc.create("company-1", { environment: "staging" });

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          environment: "staging",
          issueId: null,
          agentId: null,
          provider: null,
          url: null,
          commitSha: null,
        }),
      );
    });
  });

  describe("getById", () => {
    it("returns the deployment when found", async () => {
      const row = { id: "dep-1", companyId: "company-1", environment: "production" };
      const { select } = createSelectStub([[row]]);

      const db = { select } as any;
      const svc = deploymentService(db);
      const result = await svc.getById("company-1", "dep-1");

      expect(result).toEqual(row);
    });

    it("throws notFound when deployment does not exist", async () => {
      const { select } = createSelectStub([[]]);

      const db = { select } as any;
      const svc = deploymentService(db);

      await expect(svc.getById("company-1", "dep-missing")).rejects.toThrow(
        "Deployment not found",
      );
    });
  });

  describe("updateStatus", () => {
    it("updates status and returns the row", async () => {
      const updatedRow = {
        id: "dep-1",
        companyId: "company-1",
        status: "live",
        updatedAt: new Date(),
      };

      const { update, pendingUpdates } = createUpdateStub([]);
      pendingUpdates.push([updatedRow]);

      const db = { update } as any;
      const svc = deploymentService(db);
      const result = await svc.updateStatus("company-1", "dep-1", "live");

      expect(result).toEqual(updatedRow);
    });

    it("includes metadata when provided", async () => {
      const updatedRow = {
        id: "dep-1",
        companyId: "company-1",
        status: "failed",
        metadata: { error: "timeout" },
      };

      const { update, set, pendingUpdates } = createUpdateStub([]);
      pendingUpdates.push([updatedRow]);

      const db = { update } as any;
      const svc = deploymentService(db);
      const result = await svc.updateStatus("company-1", "dep-1", "failed", {
        error: "timeout",
      });

      expect(result).toEqual(updatedRow);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          metadata: { error: "timeout" },
        }),
      );
    });

    it("throws notFound when deployment does not exist", async () => {
      const { update, pendingUpdates } = createUpdateStub([]);
      pendingUpdates.push([]);

      const db = { update } as any;
      const svc = deploymentService(db);

      await expect(
        svc.updateStatus("company-1", "dep-missing", "live"),
      ).rejects.toThrow("Deployment not found");
    });
  });

  describe("checkHealth", () => {
    it("updates lastHealthCheckAt and returns the row", async () => {
      const updatedRow = {
        id: "dep-1",
        companyId: "company-1",
        healthStatus: "healthy",
        lastHealthCheckAt: new Date(),
      };

      const { update, set, pendingUpdates } = createUpdateStub([]);
      pendingUpdates.push([updatedRow]);

      const db = { update } as any;
      const svc = deploymentService(db);
      const result = await svc.checkHealth("company-1", "dep-1");

      expect(result).toEqual(updatedRow);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          lastHealthCheckAt: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      );
    });

    it("throws notFound when deployment does not exist", async () => {
      const { update, pendingUpdates } = createUpdateStub([]);
      pendingUpdates.push([]);

      const db = { update } as any;
      const svc = deploymentService(db);

      await expect(svc.checkHealth("company-1", "dep-missing")).rejects.toThrow(
        "Deployment not found",
      );
    });
  });

  describe("rollback", () => {
    it("sets status to rolled_back and returns the row", async () => {
      const updatedRow = {
        id: "dep-1",
        companyId: "company-1",
        status: "rolled_back",
        rolledBackAt: new Date(),
      };

      const { update, set, pendingUpdates } = createUpdateStub([]);
      pendingUpdates.push([updatedRow]);

      const db = { update } as any;
      const svc = deploymentService(db);
      const result = await svc.rollback("company-1", "dep-1");

      expect(result).toEqual(updatedRow);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "rolled_back",
          rolledBackAt: expect.any(Date),
          updatedAt: expect.any(Date),
        }),
      );
    });

    it("throws notFound when deployment does not exist", async () => {
      const { update, pendingUpdates } = createUpdateStub([]);
      pendingUpdates.push([]);

      const db = { update } as any;
      const svc = deploymentService(db);

      await expect(svc.rollback("company-1", "dep-missing")).rejects.toThrow(
        "Deployment not found",
      );
    });
  });

  describe("listForIssue", () => {
    it("returns deployments for an issue ordered by createdAt desc", async () => {
      const rows = [
        { id: "dep-2", issueId: "issue-1", createdAt: new Date("2026-02-01") },
        { id: "dep-1", issueId: "issue-1", createdAt: new Date("2026-01-01") },
      ];

      const { select } = createSelectStub([rows]);

      const db = { select } as any;
      const svc = deploymentService(db);
      const result = await svc.listForIssue("company-1", "issue-1");

      expect(result).toEqual(rows);
      expect(result).toHaveLength(2);
    });

    it("returns empty array when no deployments exist for the issue", async () => {
      const { select } = createSelectStub([[]]);

      const db = { select } as any;
      const svc = deploymentService(db);
      const result = await svc.listForIssue("company-1", "issue-missing");

      expect(result).toEqual([]);
    });
  });

  describe("listForCompany", () => {
    it("returns all deployments for a company", async () => {
      const rows = [
        { id: "dep-1", companyId: "company-1", status: "live" },
        { id: "dep-2", companyId: "company-1", status: "pending" },
      ];

      const { select } = createSelectStub([rows]);

      const db = { select } as any;
      const svc = deploymentService(db);
      const result = await svc.listForCompany("company-1");

      expect(result).toEqual(rows);
    });

    it("filters by status when provided", async () => {
      const rows = [{ id: "dep-1", companyId: "company-1", status: "live" }];

      const { select } = createSelectStub([rows]);

      const db = { select } as any;
      const svc = deploymentService(db);
      const result = await svc.listForCompany("company-1", { status: "live" });

      expect(result).toEqual(rows);
    });

    it("returns empty array when no deployments match", async () => {
      const { select } = createSelectStub([[]]);

      const db = { select } as any;
      const svc = deploymentService(db);
      const result = await svc.listForCompany("company-1", { status: "failed" });

      expect(result).toEqual([]);
    });
  });
});
