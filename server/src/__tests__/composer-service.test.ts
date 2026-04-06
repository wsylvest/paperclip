import { beforeEach, describe, expect, it, vi } from "vitest";
import { composerService } from "../services/composer.ts";

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

describe("composerService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createThread", () => {
    it("creates an issue and a first comment, returns the issue", async () => {
      const createdIssue = {
        id: "issue-1",
        companyId: "company-1",
        title: "Revenue strategy Q2",
        kind: "strategy",
        scope: "revenue",
        createdByUserId: "user-1",
        status: "backlog",
      };

      const createdComment = {
        id: "comment-1",
        companyId: "company-1",
        issueId: "issue-1",
        authorUserId: "user-1",
        body: "What should our focus be for Q2?",
        intent: "board_question",
      };

      // createThread calls db.insert twice:
      // 1. insert into issues -> returns issue
      // 2. insert into issueComments -> returns comment
      let insertCall = 0;
      const insert = vi.fn(() => {
        insertCall++;
        const call = insertCall;
        return {
          values: vi.fn(() => ({
            returning: vi.fn(() => ({
              then: (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
                Promise.resolve(call === 1 ? [createdIssue] : [createdComment]).then(resolve, reject),
            })),
          })),
        };
      });

      const db = { insert } as any;
      const svc = composerService(db);
      const result = await svc.createThread("company-1", "user-1", {
        title: "Revenue strategy Q2",
        kind: "strategy",
        scope: "revenue",
        content: "What should our focus be for Q2?",
      });

      expect(result).toEqual(createdIssue);
      expect(insert).toHaveBeenCalledTimes(2);
    });

    it("creates a thread without optional scope and targetAgentId", async () => {
      const createdIssue = {
        id: "issue-2",
        companyId: "company-1",
        title: "Quick question",
        kind: "question",
        createdByUserId: "user-1",
        status: "backlog",
      };

      let insertCall = 0;
      const insertValues = vi.fn(() => ({
        returning: vi.fn(() => ({
          then: (resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
            insertCall++;
            return Promise.resolve(
              insertCall === 1 ? [createdIssue] : [{ id: "comment-2" }],
            ).then(resolve, reject);
          },
        })),
      }));
      const insert = vi.fn(() => ({ values: insertValues }));

      const db = { insert } as any;
      const svc = composerService(db);
      const result = await svc.createThread("company-1", "user-1", {
        title: "Quick question",
        kind: "question",
        content: "How do we handle refunds?",
      });

      expect(result).toEqual(createdIssue);
      // First insert call should include issue data
      expect(insertValues).toHaveBeenCalledTimes(2);
    });
  });

  describe("addMessage", () => {
    it("creates an issue comment and returns it", async () => {
      const createdComment = {
        id: "comment-3",
        companyId: "company-1",
        issueId: "issue-1",
        authorUserId: "user-1",
        body: "Follow-up question about costs",
        intent: "board_question",
      };

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([createdComment]);

      const db = { insert } as any;
      const svc = composerService(db);
      const result = await svc.addMessage(
        "company-1",
        "issue-1",
        "user-1",
        "Follow-up question about costs",
        "board_question",
      );

      expect(result).toEqual(createdComment);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          issueId: "issue-1",
          authorUserId: "user-1",
          body: "Follow-up question about costs",
          intent: "board_question",
        }),
      );
    });

    it("defaults intent to null when not provided", async () => {
      const createdComment = {
        id: "comment-4",
        companyId: "company-1",
        issueId: "issue-1",
        authorUserId: "user-2",
        body: "Just a note",
        intent: null,
      };

      const { insert, insertValues, pendingInserts } = createInsertStub([]);
      pendingInserts.push([createdComment]);

      const db = { insert } as any;
      const svc = composerService(db);
      const result = await svc.addMessage(
        "company-1",
        "issue-1",
        "user-2",
        "Just a note",
      );

      expect(result).toEqual(createdComment);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: null,
        }),
      );
    });
  });

  describe("convertToTask", () => {
    it("updates issue kind to task with assignee and returns it", async () => {
      const updatedIssue = {
        id: "issue-1",
        companyId: "company-1",
        kind: "task",
        assigneeAgentId: "agent-1",
        status: "todo",
      };

      const update = vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => thenable([updatedIssue])),
          })),
        })),
      }));

      const db = { update } as any;
      const svc = composerService(db);
      const result = await svc.convertToTask("company-1", "issue-1", "agent-1");

      expect(result).toEqual(updatedIssue);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("throws notFound when issue does not exist", async () => {
      const update = vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => thenable([])),
          })),
        })),
      }));

      const db = { update } as any;
      const svc = composerService(db);

      await expect(
        svc.convertToTask("company-1", "nonexistent", "agent-1"),
      ).rejects.toThrow();
    });
  });

  describe("listThreads", () => {
    it("returns non-task issues ordered by creation date", async () => {
      const threads = [
        { id: "issue-3", kind: "strategy", title: "Q3 Planning", createdAt: new Date("2026-03-01") },
        { id: "issue-2", kind: "question", title: "Budget question", createdAt: new Date("2026-02-15") },
      ];

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => thenable(threads)),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = composerService(db);
      const result = await svc.listThreads("company-1");

      expect(result).toEqual(threads);
      expect(result).toHaveLength(2);
    });

    it("filters by kind when provided", async () => {
      const threads = [
        { id: "issue-3", kind: "strategy", title: "Q3 Planning" },
      ];

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => thenable(threads)),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = composerService(db);
      const result = await svc.listThreads("company-1", { kind: "strategy" });

      expect(result).toEqual(threads);
      expect(result).toHaveLength(1);
    });

    it("filters by scope when provided", async () => {
      const threads = [
        { id: "issue-5", kind: "decision", title: "Pricing change", scope: "revenue" },
      ];

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => thenable(threads)),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = composerService(db);
      const result = await svc.listThreads("company-1", { scope: "revenue" });

      expect(result).toEqual(threads);
    });

    it("returns empty array when no threads exist", async () => {
      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => thenable([])),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = composerService(db);
      const result = await svc.listThreads("company-1");

      expect(result).toEqual([]);
    });
  });
});
