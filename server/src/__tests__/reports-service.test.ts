import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportService } from "../services/reports.ts";

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
  }));
  const insert = vi.fn(() => ({ values: insertValues }));
  return { insert, insertValues, pendingInserts };
}

describe("reportService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("costTimeSeries", () => {
    it("returns time-bucketed cost rows for daily granularity", async () => {
      const rows = [
        { period: "2026-01-01", costCents: 1500, eventCount: 10 },
        { period: "2026-01-02", costCents: 2300, eventCount: 15 },
      ];

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              orderBy: vi.fn(() => thenable(rows)),
            })),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = reportService(db);
      const result = await svc.costTimeSeries(
        "company-1",
        new Date("2026-01-01"),
        new Date("2026-01-31"),
        "daily",
      );

      expect(result).toEqual(rows);
      expect(select).toHaveBeenCalledTimes(1);
    });

    it("returns time-bucketed cost rows for monthly granularity", async () => {
      const rows = [
        { period: "2026-01-01", costCents: 45000, eventCount: 300 },
        { period: "2026-02-01", costCents: 52000, eventCount: 350 },
      ];

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn(() => ({
              orderBy: vi.fn(() => thenable(rows)),
            })),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = reportService(db);
      const result = await svc.costTimeSeries(
        "company-1",
        new Date("2026-01-01"),
        new Date("2026-06-30"),
        "monthly",
      );

      expect(result).toEqual(rows);
    });

    it("returns empty array when no cost events exist", async () => {
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
      const svc = reportService(db);
      const result = await svc.costTimeSeries(
        "company-1",
        new Date("2026-01-01"),
        new Date("2026-01-31"),
        "weekly",
      );

      expect(result).toEqual([]);
    });
  });

  describe("agentPerformance", () => {
    /**
     * agentPerformance calls db.select() four times:
     *  1-3: subqueries (issueStats, costStats, allTaskStats) ending in .as()
     *  4: final query with leftJoins ending in thenable result
     */
    function createAgentPerfDb(finalRows: unknown[]) {
      let selectCall = 0;
      const subquery = { _: "subquery" };
      const select = vi.fn(() => {
        selectCall++;
        const call = selectCall;
        if (call <= 3) {
          // Subquery chains: select().from().where().groupBy().as()
          return {
            from: vi.fn(() => ({
              where: vi.fn(() => ({
                groupBy: vi.fn(() => ({
                  as: vi.fn(() => subquery),
                })),
              })),
            })),
          };
        }
        // Final query: select().from().leftJoin().leftJoin().leftJoin().where()
        return {
          from: vi.fn(() => ({
            leftJoin: vi.fn(() => ({
              leftJoin: vi.fn(() => ({
                leftJoin: vi.fn(() => ({
                  where: vi.fn(() => thenable(finalRows)),
                })),
              })),
            })),
          })),
        };
      });
      return { select } as any;
    }

    it("returns per-agent stats with joins", async () => {
      const agentRows = [
        {
          agentId: "agent-1",
          agentName: "Coder Bot",
          tasksCompleted: 12,
          avgResolutionHours: 4.5,
          totalCostCents: 3400,
          successRate: 85.71,
        },
        {
          agentId: "agent-2",
          agentName: "Review Bot",
          tasksCompleted: 8,
          avgResolutionHours: 2.1,
          totalCostCents: 1200,
          successRate: 100.0,
        },
      ];

      const db = createAgentPerfDb(agentRows);
      const svc = reportService(db);
      const result = await svc.agentPerformance(
        "company-1",
        new Date("2026-01-01"),
        new Date("2026-03-31"),
      );

      expect(result).toEqual(agentRows);
      expect(result).toHaveLength(2);
      expect(result[0].agentName).toBe("Coder Bot");
      expect(result[0].tasksCompleted).toBe(12);
    });

    it("returns empty array when no agents exist", async () => {
      const db = createAgentPerfDb([]);
      const svc = reportService(db);
      const result = await svc.agentPerformance("company-1");

      expect(result).toEqual([]);
    });
  });

  describe("generateSnapshot", () => {
    it("generates a cost snapshot and inserts into reportSnapshots", async () => {
      const costData = {
        totalCostCents: 50000,
        eventCount: 400,
        totalInputTokens: 1000000,
        totalOutputTokens: 500000,
      };

      const snapshotRow = {
        id: "snap-1",
        companyId: "company-1",
        reportType: "cost",
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-01-31"),
        data: costData,
      };

      // generateSnapshot does two db calls:
      // 1. db.select() to gather data (cost query)
      // 2. db.insert() to store snapshot
      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => thenable([costData])),
        })),
      }));

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([snapshotRow]);

      const db = { select, insert } as any;
      const svc = reportService(db);
      const result = await svc.generateSnapshot(
        "company-1",
        "cost",
        new Date("2026-01-01"),
        new Date("2026-01-31"),
      );

      expect(result).toEqual(snapshotRow);
      expect(select).toHaveBeenCalledTimes(1);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          reportType: "cost",
          data: costData,
        }),
      );
    });

    it("generates an issues snapshot and inserts into reportSnapshots", async () => {
      const issueData = {
        total: 50,
        completed: 42,
        avgResolutionHours: 6.3,
      };

      const snapshotRow = {
        id: "snap-2",
        companyId: "company-1",
        reportType: "issues",
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-03-31"),
        data: issueData,
      };

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => thenable([issueData])),
        })),
      }));

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([snapshotRow]);

      const db = { select, insert } as any;
      const svc = reportService(db);
      const result = await svc.generateSnapshot(
        "company-1",
        "issues",
        new Date("2026-01-01"),
        new Date("2026-03-31"),
      );

      expect(result).toEqual(snapshotRow);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          reportType: "issues",
          data: issueData,
        }),
      );
    });

    it("stores empty data for unknown report types", async () => {
      const snapshotRow = {
        id: "snap-3",
        companyId: "company-1",
        reportType: "unknown",
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-01-31"),
        data: {},
      };

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([snapshotRow]);

      const db = { insert } as any;
      const svc = reportService(db);
      const result = await svc.generateSnapshot(
        "company-1",
        "unknown",
        new Date("2026-01-01"),
        new Date("2026-01-31"),
      );

      expect(result).toEqual(snapshotRow);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          reportType: "unknown",
          data: {},
        }),
      );
    });
  });
});
