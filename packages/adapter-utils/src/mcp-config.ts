import fs from "node:fs/promises";
import path from "node:path";
import TOML from "@iarna/toml";
import type { AdapterExecutionContext } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface McpMaterializeTarget {
  /** Absolute path to write to. */
  filePath: string;
  /** Serialization format. */
  format: "json" | "toml";
  /**
   * A function that returns the FULL merged file content given the existing
   * parsed object (or null if the file does not exist or was unreadable) and
   * the Paperclip entry.
   */
  merge: (
    existing: Record<string, unknown> | null,
    paperclipEntry: { url: string; bearerToken: string },
  ) => Record<string, unknown>;
}

export interface McpMaterializeInput {
  ctx: AdapterExecutionContext;
  companyId: string;
  agentId: string;
  runId: string;
  /** Caller-provided list of files to write. Each entry is independently atomic. */
  targets: McpMaterializeTarget[];
}

export interface MaterializedMcpConfig {
  filesWritten: string[];
  apiKeyId: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readExistingFile(
  filePath: string,
  format: "json" | "toml",
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    if (format === "json") {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    }
    // TOML — returns a JsonMap which satisfies Record<string, unknown>
    const parsed = TOML.parse(raw);
    return parsed as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeAtomically(
  filePath: string,
  content: Record<string, unknown>,
  format: "json" | "toml",
): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  let serialized: string;
  if (format === "json") {
    serialized = JSON.stringify(content, null, 2) + "\n";
  } else {
    // @iarna/toml stringify expects a JsonMap — the merged object satisfies that
    serialized = TOML.stringify(content as TOML.JsonMap);
  }
  await fs.writeFile(tmpPath, serialized, "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Mints a single MCP gateway session key, then writes each target file
 * atomically in parallel.
 *
 * Returns null (no-op) when the ctx is missing `mintMcpSessionKey` or
 * `paperclipBaseUrl`.
 *
 * If one or more target writes fail the function still attempts all targets
 * (Promise.allSettled) and throws an aggregated error afterwards so the
 * caller can decide how to handle it.
 *
 * The bearer token is never logged.
 */
export async function materializeMcpConfig(
  input: McpMaterializeInput,
): Promise<MaterializedMcpConfig | null> {
  const { ctx, companyId, agentId, runId, targets } = input;
  const { mintMcpSessionKey, paperclipBaseUrl, onLog } = ctx;

  if (!mintMcpSessionKey || !paperclipBaseUrl) {
    return null;
  }

  let minted: { id: string; plaintext: string; expiresAt: Date };
  try {
    minted = await mintMcpSessionKey({ companyId, agentId, runId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await onLog(
      "stderr",
      `[paperclip] MCP config: failed to mint MCP gateway session key: ${reason}. Skipping MCP config materialization.\n`,
    );
    return null;
  }

  const paperclipEntry = {
    url: `${paperclipBaseUrl}/api/companies/${companyId}/mcp/rpc`,
    bearerToken: minted.plaintext,
  };

  const results = await Promise.allSettled(
    targets.map(async (target) => {
      const dir = path.dirname(target.filePath);
      await fs.mkdir(dir, { recursive: true });

      const existing = await readExistingFile(target.filePath, target.format);
      const merged = target.merge(existing, paperclipEntry);
      await writeAtomically(target.filePath, merged, target.format);
      await onLog(
        "stdout",
        `[paperclip] MCP config: wrote ${target.filePath} with Paperclip gateway entry.\n`,
      );
    }),
  );

  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failures.length > 0) {
    const reasons = failures
      .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
      .join("; ");
    throw new Error(
      `[paperclip] MCP config: ${failures.length} of ${targets.length} target(s) failed to write: ${reasons}`,
    );
  }

  const filesWritten = targets.map((t) => t.filePath);
  await onLog(
    "stdout",
    `[paperclip] MCP config: materialized ${filesWritten.length} file(s) (keyId=${minted.id}, expires=${minted.expiresAt.toISOString()}).\n`,
  );

  return {
    filesWritten,
    apiKeyId: minted.id,
    expiresAt: minted.expiresAt.toISOString(),
  };
}
