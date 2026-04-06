import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessService } from "../services/access.ts";

type SelectResult = unknown[];

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

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];

  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(resolve(pendingSelects.shift() ?? [])),
  );
  const selectWhere = vi.fn(() => ({
    then: selectThen,
    orderBy: selectOrderBy,
  }));
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    leftJoin: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(async () => pendingSelects.shift() ?? []),
      })),
    })),
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const pendingUpdates: unknown[][] = [];
  const updateReturning = vi.fn(() => ({
    then: vi.fn((resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(resolve(pendingUpdates.shift() ?? [])),
    ),
  }));
  const updateWhere = vi.fn(() => ({
    returning: updateReturning,
  }));
  const updateSet = vi.fn(() => ({
    where: updateWhere,
  }));
  const update = vi.fn(() => ({
    set: updateSet,
  }));

  const txUpdateWhere = vi.fn();
  const txUpdateSet = vi.fn(() => ({ where: txUpdateWhere }));
  const txUpdate = vi.fn(() => ({ set: txUpdateSet }));
  const transaction = vi.fn(async (cb: (tx: any) => Promise<void>) => {
    await cb({ update: txUpdate });
  });

  return {
    db: { select, update, transaction },
    selectThen,
    selectWhere,
    updateSet,
    updateReturning,
    txUpdate,
    txUpdateSet,
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
        // 1st select: find the target member by memberId
        targetMember,
        // 2nd select: find actor's membership (the owner)
        ownerMembership,
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

      const dbStub = createDbStub([
        targetMember,
        // no actor membership found
        null,
      ]);

      const svc = accessService(dbStub.db as any);

      await expect(
        svc.updateMemberRole("company-1", "mem-target", "admin" as any, "ghost-user"),
      ).rejects.toThrow("Only the owner can change member roles");
    });

    it("throws not-found when the target member does not exist", async () => {
      const dbStub = createDbStub([
        // no member found
        null,
      ]);

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
        // target member is the owner themselves
        ownerMember,
        // actor membership (same owner)
        ownerMember,
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
        // 1st select: find current owner membership
        currentOwner,
        // 2nd select: find new owner membership
        newOwner,
      ]);

      const svc = accessService(dbStub.db as any);
      const result = await svc.transferOwnership("company-1", "owner-1", "user-2");

      expect(result).toEqual({
        previousOwnerId: "owner-1",
        newOwnerId: "user-2",
      });
      // Verify the transaction was called
      expect(dbStub.db.transaction).toHaveBeenCalledTimes(1);
    });

    it("throws forbidden when the actor is not the current owner", async () => {
      const dbStub = createDbStub([
        // no owner membership found
        null,
      ]);

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
        // new owner not found
        null,
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

      const selectWhere = vi.fn(() => ({
        orderBy: vi.fn(async () => memberships),
      }));
      const selectLeftJoin = vi.fn(() => ({
        where: selectWhere,
      }));
      const selectFrom = vi.fn(() => ({
        leftJoin: selectLeftJoin,
      }));
      const select = vi.fn(() => ({ from: selectFrom }));

      const db = { select } as any;
      const svc = accessService(db);
      const result = await svc.listCompanyUsers("company-1");

      expect(result).toEqual(memberships);
      expect(result).toHaveLength(2);
      expect(result[0].userName).toBe("Alice");
      expect(result[1].userName).toBe("Bob");
    });

    it("returns empty array when no members exist", async () => {
      const selectWhere = vi.fn(() => ({
        orderBy: vi.fn(async () => []),
      }));
      const selectLeftJoin = vi.fn(() => ({
        where: selectWhere,
      }));
      const selectFrom = vi.fn(() => ({
        leftJoin: selectLeftJoin,
      }));
      const select = vi.fn(() => ({ from: selectFrom }));

      const db = { select } as any;
      const svc = accessService(db);
      const result = await svc.listCompanyUsers("company-1");

      expect(result).toEqual([]);
    });
  });
});
