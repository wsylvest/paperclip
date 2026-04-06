import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditService } from "../services/audit.ts";

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];

  const selectGroupBy = vi.fn(() => ({
    orderBy: vi.fn(async () => pendingSelects.shift() ?? []),
  }));
  const selectWhere = vi.fn(() => ({
    orderBy: vi.fn(() => ({
      limit: vi.fn(() => ({
        offset: vi.fn(async () => pendingSelects.shift() ?? []),
      })),
    })),
    groupBy: selectGroupBy,
    then: vi.fn((resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(resolve(pendingSelects.shift() ?? [])),
    ),
  }));
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const insertReturning = vi.fn(async () => pendingInserts.shift() ?? []);
  const insertOnConflict = vi.fn(() => ({
    returning: insertReturning.mockImplementation(() => ({
      then: vi.fn((resolve: (v: unknown[]) => unknown) =>
        Promise.resolve(resolve(pendingInserts.shift() ?? [])),
      ),
    })),
  }));
  const insertValues = vi.fn(() => ({
    returning: insertReturning.mockImplementation(() => ({
      then: vi.fn((resolve: (v: unknown[]) => unknown) =>
        Promise.resolve(resolve(pendingInserts.shift() ?? [])),
      ),
    })),
    onConflictDoUpdate: insertOnConflict,
  }));
  const insert = vi.fn(() => ({
    values: insertValues,
  }));

  const pendingInserts: unknown[][] = [];

  return {
    db: { select, insert },
    queueInsert: (rows: unknown[]) => {
      pendingInserts.push(rows);
    },
    select: select,
    selectFrom,
    selectWhere,
    insertValues,
  };
}

describe("auditService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("logAuditEvent", () => {
    it("inserts an audit event and returns the row", async () => {
      const insertedRow = {
        id: "evt-1",
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        category: "auth",
        action: "login",
        entityType: "session",
        entityId: "session-1",
        severity: "info",
        previousState: null,
        newState: null,
        ipAddress: null,
        userAgent: null,
        metadata: null,
        occurredAt: new Date(),
      };

      const dbStub = createDbStub([]);
      dbStub.queueInsert([insertedRow]);

      const svc = auditService(dbStub.db as any);
      const result = await svc.logAuditEvent({
        companyId: "company-1",
        actorType: "user",
        actorId: "user-1",
        category: "auth",
        action: "login",
        entityType: "session",
        entityId: "session-1",
      });

      expect(result).toEqual(insertedRow);
      expect(dbStub.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          actorType: "user",
          actorId: "user-1",
          category: "auth",
          action: "login",
          entityType: "session",
          entityId: "session-1",
          severity: "info",
        }),
      );
    });

    it("defaults severity to info and nullable fields to null", async () => {
      const insertedRow = {
        id: "evt-2",
        companyId: null,
        actorType: "system",
        actorId: "cron",
        category: "system",
        action: "cleanup",
        entityType: "audit",
        entityId: "batch-1",
        severity: "info",
        previousState: null,
        newState: null,
        ipAddress: null,
        userAgent: null,
        metadata: null,
      };

      const dbStub = createDbStub([]);
      dbStub.queueInsert([insertedRow]);

      const svc = auditService(dbStub.db as any);
      await svc.logAuditEvent({
        actorType: "system",
        actorId: "cron",
        category: "system",
        action: "cleanup",
        entityType: "audit",
        entityId: "batch-1",
      });

      expect(dbStub.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: null,
          severity: "info",
          previousState: null,
          newState: null,
          ipAddress: null,
          userAgent: null,
          metadata: null,
        }),
      );
    });
  });

  describe("query", () => {
    it("returns items and total with default limit/offset", async () => {
      const items = [
        { id: "evt-1", category: "auth", action: "login" },
        { id: "evt-2", category: "auth", action: "logout" },
      ];
      const totalRow = { count: 42 };

      // query calls Promise.all with two db.select() chains:
      // one for items (with limit/offset) and one for total (with .then)
      const itemsWhere = vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => ({
            offset: vi.fn(async () => items),
          })),
        })),
      }));
      const totalWhere = vi.fn(() => ({
        then: vi.fn((resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve(totalRow)),
        ),
      }));

      let selectCallCount = 0;
      const selectFrom = vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { where: itemsWhere };
        return { where: totalWhere };
      });
      const select = vi.fn(() => ({ from: selectFrom }));

      const db = { select } as any;
      const svc = auditService(db);
      const result = await svc.query("company-1");

      expect(result.items).toEqual(items);
      expect(result.total).toBe(42);
    });

    it("returns zero total when no count row is returned", async () => {
      const itemsWhere = vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => ({
            offset: vi.fn(async () => []),
          })),
        })),
      }));
      const totalWhere = vi.fn(() => ({
        then: vi.fn((resolve: (v: unknown) => unknown) =>
          Promise.resolve(resolve(undefined)),
        ),
      }));

      let selectCallCount = 0;
      const selectFrom = vi.fn(() => {
        selectCallCount++;
        if (selectCallCount === 1) return { where: itemsWhere };
        return { where: totalWhere };
      });
      const select = vi.fn(() => ({ from: selectFrom }));

      const db = { select } as any;
      const svc = auditService(db);
      const result = await svc.query("company-1", { category: "auth" });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe("complianceSummary", () => {
    it("returns grouped rows by category and severity", async () => {
      const groupedRows = [
        { category: "auth", severity: "info", count: 10 },
        { category: "auth", severity: "warning", count: 3 },
        { category: "data", severity: "critical", count: 1 },
      ];

      const selectWhere = vi.fn(() => ({
        groupBy: vi.fn(() => ({
          orderBy: vi.fn(async () => groupedRows),
        })),
      }));
      const selectFrom = vi.fn(() => ({ where: selectWhere }));
      const select = vi.fn(() => ({ from: selectFrom }));

      const db = { select } as any;
      const svc = auditService(db);
      const result = await svc.complianceSummary("company-1", {
        from: new Date("2026-01-01"),
        to: new Date("2026-03-31"),
      });

      expect(result).toEqual([
        { category: "auth", severity: "info", count: 10 },
        { category: "auth", severity: "warning", count: 3 },
        { category: "data", severity: "critical", count: 1 },
      ]);
    });

    it("returns empty array when no events exist", async () => {
      const selectWhere = vi.fn(() => ({
        groupBy: vi.fn(() => ({
          orderBy: vi.fn(async () => []),
        })),
      }));
      const selectFrom = vi.fn(() => ({ where: selectWhere }));
      const select = vi.fn(() => ({ from: selectFrom }));

      const db = { select } as any;
      const svc = auditService(db);
      const result = await svc.complianceSummary("company-1");

      expect(result).toEqual([]);
    });
  });

  describe("getRetentionPolicies", () => {
    it("returns policies for a company", async () => {
      const policies = [
        { id: "rp-1", companyId: "company-1", category: "auth", retentionDays: 90, isActive: true },
        { id: "rp-2", companyId: "company-1", category: "data", retentionDays: 365, isActive: true },
      ];

      const selectWhere = vi.fn(() => ({
        orderBy: vi.fn(async () => policies),
      }));
      const selectFrom = vi.fn(() => ({ where: selectWhere }));
      const select = vi.fn(() => ({ from: selectFrom }));

      const db = { select } as any;
      const svc = auditService(db);
      const result = await svc.getRetentionPolicies("company-1");

      expect(result).toEqual(policies);
    });

    it("returns empty array when no policies exist", async () => {
      const selectWhere = vi.fn(() => ({
        orderBy: vi.fn(async () => []),
      }));
      const selectFrom = vi.fn(() => ({ where: selectWhere }));
      const select = vi.fn(() => ({ from: selectFrom }));

      const db = { select } as any;
      const svc = auditService(db);
      const result = await svc.getRetentionPolicies("company-1");

      expect(result).toEqual([]);
    });
  });

  describe("upsertRetentionPolicy", () => {
    it("inserts or updates a retention policy and returns the row", async () => {
      const upsertedRow = {
        id: "rp-1",
        companyId: "company-1",
        category: "auth",
        retentionDays: 180,
        isActive: true,
      };

      const dbStub = createDbStub([]);
      dbStub.queueInsert([upsertedRow]);

      const svc = auditService(dbStub.db as any);
      const result = await svc.upsertRetentionPolicy("company-1", {
        category: "auth",
        retentionDays: 180,
        isActive: true,
      });

      expect(result).toEqual(upsertedRow);
      expect(dbStub.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          category: "auth",
          retentionDays: 180,
          isActive: true,
        }),
      );
    });
  });
});
