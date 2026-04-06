import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessService } from "../services/access.ts";

/**
 * Creates a thenable that resolves with `value`.
 * Drizzle query builders are thenables — `.then(cb)` both chains
 * and triggers execution when consumed by `await` / `Promise.all`.
 */
function thenable<T>(value: T) {
  return {
    then: (resolve?: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
}

function makeMembership(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    companyId: "company-1",
    principalType: "user",
    principalId: "user-1",
    membershipRole: "member",
    status: "active",
    invitedBy: null,
    lastActiveAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Build a db stub whose `select().from().where()` returns a thenable
 * for each queued result in order. Each result is an array of rows;
 * callers using `.then(rows => rows[0] ?? null)` will unwrap as expected.
 */
function createDbStub(selectResults: unknown[]) {
  const pending = [...selectResults];

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => thenable(Array.isArray(pending[0]) ? pending.shift() : [pending.shift()])),
      leftJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => thenable(pending.shift() ?? [])),
        })),
      })),
    })),
  }));

  const pendingUpdates: unknown[][] = [];
  const updateSet = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(() => thenable(pendingUpdates.shift() ?? [])),
    })),
  }));
  const update = vi.fn(() => ({ set: updateSet }));

  const txUpdateSet = vi.fn(() => ({ where: vi.fn() }));
  const txUpdate = vi.fn(() => ({ set: txUpdateSet }));
  const transaction = vi.fn(async (cb: (tx: any) => Promise<void>) => {
    await cb({ update: txUpdate });
  });

  return {
    db: { select, update, transaction },
    updateSet,
    txUpdate,
    queueUpdate: (rows: unknown[]) => {
      pendingUpdates.push(rows);
    },
  };
}

describe("accessService – member role enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("updateMemberRole", () => {
    it("allows the owner to change a member's role", async () => {
      const targetMember = makeMembership({
        id: "mem-target",
        principalId: "user-target",
        membershipRole: "member",
      });
      const ownerMembership = makeMembership({
        id: "mem-owner",
        principalId: "owner-1",
        membershipRole: "owner",
      });
      const updatedMember = { ...targetMember, membershipRole: "admin" };

      const dbStub = createDbStub([
        targetMember,    // find target member
        ownerMembership, // find actor membership (owner)
      ]);
      dbStub.queueUpdate([updatedMember]);

      const svc = accessService(dbStub.db as any);
      const result = await svc.updateMemberRole("company-1", "mem-target", "admin" as any, "owner-1");

      expect(result.member).toEqual(updatedMember);
      expect(result.previousRole).toBe("member");
    });

    it("throws forbidden when a non-owner tries to change roles", async () => {
      const targetMember = makeMembership({
        id: "mem-target",
        principalId: "user-target",
        membershipRole: "member",
      });
      const nonOwnerMembership = makeMembership({
        id: "mem-actor",
        principalId: "user-actor",
        membershipRole: "admin",
      });

      const dbStub = createDbStub([
        targetMember,
        nonOwnerMembership,
      ]);

      const svc = accessService(dbStub.db as any);

      await expect(
        svc.updateMemberRole("company-1", "mem-target", "viewer" as any, "user-actor"),
      ).rejects.toThrow("Only the owner can change member roles");
    });

    it("throws forbidden when actor has no membership", async () => {
      const targetMember = makeMembership({
        id: "mem-target",
        principalId: "user-target",
      });

      // First select returns the target member, second select returns empty (no actor)
      const dbStub = createDbStub([
        targetMember,
        null,
      ]);

      const svc = accessService(dbStub.db as any);

      await expect(
        svc.updateMemberRole("company-1", "mem-target", "admin" as any, "ghost-user"),
      ).rejects.toThrow("Only the owner can change member roles");
    });

    it("throws not-found when the target member does not exist", async () => {
      // First select returns empty (no target member)
      const dbStub = createDbStub([null]);

      const svc = accessService(dbStub.db as any);

      await expect(
        svc.updateMemberRole("company-1", "mem-missing", "admin" as any, "owner-1"),
      ).rejects.toThrow("Member not found");
    });

    it("throws unprocessable when owner tries to change their own role", async () => {
      const ownerMember = makeMembership({
        id: "mem-owner",
        principalId: "owner-1",
        principalType: "user",
        membershipRole: "owner",
      });

      const dbStub = createDbStub([
        ownerMember, // target member is the owner
        ownerMember, // actor membership (same owner)
      ]);

      const svc = accessService(dbStub.db as any);

      await expect(
        svc.updateMemberRole("company-1", "mem-owner", "admin" as any, "owner-1"),
      ).rejects.toThrow("Cannot change your own role");
    });

    it("throws unprocessable when trying to promote to owner", async () => {
      const targetMember = makeMembership({
        id: "mem-target",
        principalId: "user-target",
        membershipRole: "admin",
      });
      const ownerMembership = makeMembership({
        id: "mem-owner",
        principalId: "owner-1",
        membershipRole: "owner",
      });

      const dbStub = createDbStub([
        targetMember,
        ownerMembership,
      ]);

      const svc = accessService(dbStub.db as any);

      await expect(
        svc.updateMemberRole("company-1", "mem-target", "owner" as any, "owner-1"),
      ).rejects.toThrow("Use transferOwnership to transfer the owner role");
    });
  });

  describe("transferOwnership", () => {
    it("transfers ownership from current owner to an existing member", async () => {
      const currentOwner = makeMembership({
        id: "mem-owner",
        principalId: "owner-1",
        membershipRole: "owner",
      });
      const newOwner = makeMembership({
        id: "mem-new-owner",
        principalId: "user-2",
        membershipRole: "admin",
      });

      const dbStub = createDbStub([
        currentOwner, // find current owner
        newOwner,     // find new owner
      ]);

      const svc = accessService(dbStub.db as any);
      const result = await svc.transferOwnership("company-1", "owner-1", "user-2");

      expect(result).toEqual({
        previousOwnerId: "owner-1",
        newOwnerId: "user-2",
      });
      expect(dbStub.db.transaction).toHaveBeenCalledTimes(1);
    });

    it("throws forbidden when the actor is not the current owner", async () => {
      const dbStub = createDbStub([null]);

      const svc = accessService(dbStub.db as any);

      await expect(
        svc.transferOwnership("company-1", "not-owner", "user-2"),
      ).rejects.toThrow("Only the current owner can transfer ownership");
    });

    it("throws not-found when the new owner is not an existing member", async () => {
      const currentOwner = makeMembership({
        id: "mem-owner",
        principalId: "owner-1",
        membershipRole: "owner",
      });

      const dbStub = createDbStub([
        currentOwner,
        null, // new owner not found
      ]);

      const svc = accessService(dbStub.db as any);

      await expect(
        svc.transferOwnership("company-1", "owner-1", "ghost-user"),
      ).rejects.toThrow("New owner must be an existing member");
    });
  });

  describe("listCompanyUsers", () => {
    it("returns memberships with user info from the join", async () => {
      const memberships = [
        {
          id: "mem-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-1",
          membershipRole: "owner",
          status: "active",
          invitedBy: null,
          lastActiveAt: null,
          createdAt: new Date("2026-01-01"),
          userName: "Alice",
          userEmail: "alice@example.com",
        },
        {
          id: "mem-2",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-2",
          membershipRole: "member",
          status: "active",
          invitedBy: "user-1",
          lastActiveAt: null,
          createdAt: new Date("2026-02-01"),
          userName: "Bob",
          userEmail: "bob@example.com",
        },
      ];

      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => thenable(memberships)),
            })),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = accessService(db);
      const result = await svc.listCompanyUsers("company-1");

      expect(result).toEqual(memberships);
      expect(result).toHaveLength(2);
      expect(result[0].userName).toBe("Alice");
      expect(result[1].userName).toBe("Bob");
    });

    it("returns empty array when no members exist", async () => {
      const select = vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => thenable([])),
            })),
          })),
        })),
      }));

      const db = { select } as any;
      const svc = accessService(db);
      const result = await svc.listCompanyUsers("company-1");

      expect(result).toEqual([]);
    });
  });
});
