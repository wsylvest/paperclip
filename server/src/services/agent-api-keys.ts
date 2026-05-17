import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys } from "@paperclipai/db";

const MCP_GATEWAY_SESSION_LABEL_PREFIX = "mcp-gateway-session";
const DEFAULT_TTL_HOURS = 6;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createToken(): string {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

export interface MintedMcpGatewaySessionKey {
  id: string;
  plaintext: string;
  expiresAt: Date;
}

export function agentApiKeyService(db: Db) {
  return {
    /**
     * Mint a short-lived API key scoped to a single MCP gateway session.
     * The plaintext is returned exactly once; only the hash is stored.
     * The key expires automatically after `ttlHours` hours (default 6).
     */
    mintMcpGatewaySessionKey: async (opts: {
      companyId: string;
      agentId: string;
      runId: string;
      ttlHours?: number;
    }): Promise<MintedMcpGatewaySessionKey> => {
      const ttlHours = opts.ttlHours ?? DEFAULT_TTL_HOURS;
      const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
      const plaintext = createToken();
      const keyHash = hashToken(plaintext);
      const label = `${MCP_GATEWAY_SESSION_LABEL_PREFIX}-${opts.runId}`;

      const row = await db
        .insert(agentApiKeys)
        .values({
          agentId: opts.agentId,
          companyId: opts.companyId,
          name: label,
          label,
          keyHash,
          expiresAt,
        })
        .returning({ id: agentApiKeys.id })
        .then((rows) => rows[0]);

      if (!row) {
        throw new Error("Failed to mint MCP gateway session key");
      }

      return { id: row.id, plaintext, expiresAt };
    },

    /**
     * Revoke a previously minted MCP gateway session key by id.
     * Best-effort: if the key doesn't exist, the call succeeds silently.
     */
    revokeMcpGatewaySessionKey: async (opts: { id: string }): Promise<void> => {
      await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(agentApiKeys.id, opts.id), isNull(agentApiKeys.revokedAt)));
    },
  };
}
