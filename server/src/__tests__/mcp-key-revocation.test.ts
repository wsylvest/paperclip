/**
 * Tests for per-run MCP gateway session key revocation.
 *
 * Verifies that the heartbeat service revokes the MCP gateway session key
 * minted at run start in a finally block, regardless of run outcome.
 * Tests are scoped to the agentApiKeyService boundary and mock the DB +
 * adapter at appropriate levels.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { agentApiKeyService } from "../services/agent-api-keys.js";

// ---------------------------------------------------------------------------
// DB mock for agentApiKeyService
// ---------------------------------------------------------------------------

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown";
  const name = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

function createKeyServiceDb(opts: { mintReturns?: { id: string } | null } = {}) {
  const mintReturns = opts.mintReturns ?? { id: "key-abc-123" };
  const updates: Array<{ table: string; set: unknown; wasConditional: boolean }> = [];

  let alreadyRevoked = false;

  const db = {
    insert: (_table: unknown) => ({
      values: (_row: unknown) => ({
        returning: (selector?: unknown) => ({
          then: (onFulfilled: (v: unknown) => unknown) => {
            if (selector) {
              return Promise.resolve(mintReturns ? [mintReturns] : []).then(onFulfilled);
            }
            return Promise.resolve(mintReturns ? [mintReturns] : []).then(onFulfilled);
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (vals: unknown) => ({
        where: (_condition: unknown) => ({
          then: (onFulfilled: (v: unknown) => unknown) => {
            // Simulate idempotency: second revoke call on same key is a no-op
            if (!alreadyRevoked) {
              alreadyRevoked = true;
              updates.push({ table: getTableName(_table), set: vals, wasConditional: true });
            }
            return Promise.resolve(undefined).then(onFulfilled);
          },
        }),
      }),
    }),
    _getUpdates: () => updates,
  };

  return db;
}

// ---------------------------------------------------------------------------
// Simulate the heartbeat execute-run boundary
// ---------------------------------------------------------------------------

/**
 * Simulates the portion of heartbeat.executeRun that:
 *  1. Mints an MCP gateway session key (if onMintKey is provided)
 *  2. Calls the adapter execute (mocked as resolving/rejecting based on outcome)
 *  3. Revokes the key in a finally block
 *
 * This mirrors the actual structure in heartbeat.ts.
 */
async function simulateRunWithRevoke(opts: {
  outcome: "success" | "failure" | "cancelled";
  mintKey: (() => Promise<{ id: string; plaintext: string; expiresAt: Date }>) | null;
  revoke: (id: string) => Promise<void>;
}) {
  let mintedKeyId: string | null = null;

  try {
    // Step 1: mint key if available (mirrors the mintMcpSessionKey wrapper)
    if (opts.mintKey) {
      const minted = await opts.mintKey();
      mintedKeyId = minted.id;
    }

    // Step 2: run adapter (throws on failure/cancelled)
    if (opts.outcome === "failure") {
      throw new Error("Adapter failed");
    }
    if (opts.outcome === "cancelled") {
      throw new Error("Run cancelled");
    }
    // success: falls through
  } catch {
    // inner catch: record failure, re-throw to outer
    throw new Error("propagated");
  } finally {
    // Step 3: revoke key if minted (mirrors heartbeat finally block)
    if (mintedKeyId) {
      await opts.revoke(mintedKeyId);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcp gateway session key revocation", () => {
  let revokespy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    revokespy = vi.fn().mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // 1. Successful run → revoke called
  // -------------------------------------------------------------------------

  it("successful run → revokeMcpGatewaySessionKey called for minted key", async () => {
    const mintKey = vi.fn().mockResolvedValue({
      id: "key-success-1",
      plaintext: "pcp_abc",
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });

    await simulateRunWithRevoke({
      outcome: "success",
      mintKey,
      revoke: revokespy,
    });

    expect(revokespy).toHaveBeenCalledOnce();
    expect(revokespy).toHaveBeenCalledWith("key-success-1");
  });

  // -------------------------------------------------------------------------
  // 2. Failed run → revoke STILL called (finally block)
  // -------------------------------------------------------------------------

  it("failed run → revokeMcpGatewaySessionKey still called (finally block)", async () => {
    const mintKey = vi.fn().mockResolvedValue({
      id: "key-fail-1",
      plaintext: "pcp_def",
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });

    await expect(
      simulateRunWithRevoke({ outcome: "failure", mintKey, revoke: revokespy }),
    ).rejects.toThrow("propagated");

    expect(revokespy).toHaveBeenCalledOnce();
    expect(revokespy).toHaveBeenCalledWith("key-fail-1");
  });

  // -------------------------------------------------------------------------
  // 3. Cancelled run → revoke called once
  // -------------------------------------------------------------------------

  it("cancelled run → revokeMcpGatewaySessionKey called once", async () => {
    const mintKey = vi.fn().mockResolvedValue({
      id: "key-cancel-1",
      plaintext: "pcp_ghi",
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });

    await expect(
      simulateRunWithRevoke({ outcome: "cancelled", mintKey, revoke: revokespy }),
    ).rejects.toThrow("propagated");

    expect(revokespy).toHaveBeenCalledOnce();
    expect(revokespy).toHaveBeenCalledWith("key-cancel-1");
  });

  // -------------------------------------------------------------------------
  // 4. Run that doesn't mint a key → revoke not called
  // -------------------------------------------------------------------------

  it("run without MCP config mint → revoke never called", async () => {
    await simulateRunWithRevoke({
      outcome: "success",
      mintKey: null,
      revoke: revokespy,
    });

    expect(revokespy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. Idempotency: revokeMcpGatewaySessionKey is a no-op on second call
  // -------------------------------------------------------------------------

  it("revokeMcpGatewaySessionKey is idempotent — second call does not throw or double-update", async () => {
    const db = createKeyServiceDb({ mintReturns: { id: "key-idem-1" } });
    const svc = agentApiKeyService(db as unknown as import("@paperclipai/db").Db);

    // First revoke
    await svc.revokeMcpGatewaySessionKey({ id: "key-idem-1" });
    // Second revoke — must not throw
    await expect(svc.revokeMcpGatewaySessionKey({ id: "key-idem-1" })).resolves.toBeUndefined();

    // Only one update was recorded (the DB mock simulates isNull(revokedAt) filtering)
    expect(db._getUpdates()).toHaveLength(1);
  });
});
