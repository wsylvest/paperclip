import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditService } from "../services/audit.ts";

/**
 * Helper: creates a thenable object that resolves with `value`.
 * Drizzle query builders are thenables — `.then(cb)` both chains
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
    onConflictDoUpdate: vi.fn(() => ({
      returning: vi.fn(() => ({
        then: (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(pendingInserts.shift() ?? []).then(resolve, reject),
      })),
    })),
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  return { insert, insertValues, pendingInserts };
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

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([insertedRow]);

      const db = { insert } as any;
      const svc = auditService(db);
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
      expect(insertValues).toHaveBeenCalledWith(
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
      };

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([insertedRow]);

      const db = { insert } as any;
      const svc = auditService(db);
      await svc.logAuditEvent({
        actorType: "system",
        actorId: "cron",
        category: "system",
        action: "cleanup",
        entityType: "audit",
        entityId: "batch-1",
      });

      expect(insertValues).toHaveBeenCalledWith(
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
      const totalRows = [{ count: 42 }];

      // query() calls Promise.all with two db.select() chains
      // Chain 1: select().from().where().orderBy().limit().offset() -> items
      // Chain 2: select({count}).from().where().then(rows => rows[0]) -> total
      let selectCall = 0;
      const select = vi.fn(() => {
        selectCall++;
        const call = selectCall;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => {
              if (call === 1) {
                return {
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      offset: vi.fn(() => thenable(items)),
                    })),
                  })),
                };
              }
              // Second chain: the totalResult query with .then()
              return thenable(totalRows);
            }),
          })),
        };
      });

      const db = { select } as any;
      const svc = auditService(db);
      const result = await svc.query("company-1");

      expect(result.items).toEqual(items);
      expect(result.total).toBe(42);
    });

    it("returns zero total when no count row is returned", async () => {
      let selectCall = 0;
      const select = vi.fn(() => {
        selectCall++;
        const call = selectCall;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => {
              if (call === 1) {
                return {
                  orderBy: vi.fn(() => ({
                    limit: vi.fn(() => ({
                      offset: vi.fn(() => thenable([])),
                    })),
                  })),
                };
              }
              return thenable([]);
            }),
          })),
        };
      });

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

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              orderBy: vi.fn(() => thenable(groupedRows)),
            })),
          })),
        })),
      }));

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
      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              orderBy: vi.fn(() => thenable([])),
            })),
          })),
        })),
      }));

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

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => thenable(policies)),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = auditService(db);
      const result = await svc.getRetentionPolicies("company-1");

      expect(result).toEqual(policies);
    });

    it("returns empty array when no policies exist", async () => {
      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => thenable([])),
          })),
        })),
      }));

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

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([upsertedRow]);

      const db = { insert } as any;
      const svc = auditService(db);
      const result = await svc.upsertRetentionPolicy("company-1", {
        category: "auth",
        retentionDays: 180,
        isActive: true,
      });

      expect(result).toEqual(upsertedRow);
      expect(insertValues).toHaveBeenCalledWith(
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
