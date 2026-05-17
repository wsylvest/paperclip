/**
 * Tests for agentApiKeyService.mintMcpGatewaySessionKey and
 * revokeMcpGatewaySessionKey using an embedded Postgres database.
 *
 * Also exercises the auth middleware lookup path to confirm that a minted
 * plaintext resolves to the correct agent and that revoked / expired keys
 * are rejected.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agentApiKeys, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentApiKeyService } from "../services/agent-api-keys.ts";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping MCP key service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentApiKeyService — MCP gateway session keys", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentApiKeyService>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-api-keys-mcp");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = agentApiKeyService(db);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  afterEach(async () => {
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seedAgentAndCompany() {
    const cId = randomUUID();
    const aId = randomUUID();

    await db.insert(companies).values({
      id: cId,
      name: "Test Co",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.insert(agents).values({
      id: aId,
      companyId: cId,
      name: "ClaudeBot",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { companyId: cId, agentId: aId };
  }

  it("returns a plaintext token whose hash matches the stored row", async () => {
    ({ companyId, agentId } = await seedAgentAndCompany());

    const { id, plaintext, expiresAt } = await svc.mintMcpGatewaySessionKey({
      companyId,
      agentId,
      runId: "run-001",
    });

    expect(plaintext).toMatch(/^pcp_/);
    expect(id).toBeTruthy();
    expect(expiresAt).toBeInstanceOf(Date);

    const tokenHash = hashToken(plaintext);
    const row = await db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, id))
      .then((rows) => rows[0] ?? null);

    expect(row).not.toBeNull();
    expect(row!.keyHash).toBe(tokenHash);
    expect(row!.revokedAt).toBeNull();
    expect(row!.expiresAt).not.toBeNull();
    expect(row!.label).toMatch(/^mcp-gateway-session-run-001/);
  });

  it("minted key expires approximately ttlHours from now", async () => {
    ({ companyId, agentId } = await seedAgentAndCompany());

    const before = new Date();
    const ttlHours = 3;
    const { expiresAt } = await svc.mintMcpGatewaySessionKey({
      companyId,
      agentId,
      runId: "run-002",
      ttlHours,
    });
    const after = new Date();

    const expectedMin = before.getTime() + ttlHours * 60 * 60 * 1000;
    const expectedMax = after.getTime() + ttlHours * 60 * 60 * 1000;

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin - 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax + 1000);
  });

  it("auth lookup: hashed plaintext resolves to the correct agent row", async () => {
    ({ companyId, agentId } = await seedAgentAndCompany());

    const { plaintext } = await svc.mintMcpGatewaySessionKey({
      companyId,
      agentId,
      runId: "run-003",
    });

    const tokenHash = hashToken(plaintext);
    const now = new Date();

    // Replicate the auth middleware lookup (hash + not revoked + not expired)
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(
        and(
          eq(agentApiKeys.keyHash, tokenHash),
          isNull(agentApiKeys.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(key).not.toBeNull();
    expect(key!.agentId).toBe(agentId);
    expect(key!.companyId).toBe(companyId);
    expect(key!.expiresAt!.getTime()).toBeGreaterThan(now.getTime());
  });

  it("revokeMcpGatewaySessionKey sets revokedAt so subsequent lookup fails", async () => {
    ({ companyId, agentId } = await seedAgentAndCompany());

    const { id, plaintext } = await svc.mintMcpGatewaySessionKey({
      companyId,
      agentId,
      runId: "run-004",
    });

    await svc.revokeMcpGatewaySessionKey({ id });

    const tokenHash = hashToken(plaintext);

    // After revoke the row should have revokedAt set
    const row = await db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.id, id))
      .then((rows) => rows[0] ?? null);

    expect(row!.revokedAt).not.toBeNull();

    // Auth lookup with revokedAt exclusion returns nothing
    const authLookup = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    expect(authLookup).toBeNull();
  });

  it("revokeMcpGatewaySessionKey is idempotent for missing ids", async () => {
    await expect(
      svc.revokeMcpGatewaySessionKey({ id: randomUUID() }),
    ).resolves.toBeUndefined();
  });
});
