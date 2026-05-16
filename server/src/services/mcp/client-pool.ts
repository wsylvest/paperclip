/**
 * MCP client pool: one connected upstream client per (companyId, serverId).
 *
 * Clients are reused for up to 15 minutes. A simple circuit-breaker refuses
 * acquire for 60 s after 3 consecutive failures.
 *
 * Only `transport=streamable_http` is supported in this commit.
 * stdio / sse_legacy throw `UnsupportedTransportError`.
 */
import type { Db } from "@paperclipai/db";
import { mcpServers } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { secretService } from "../secrets.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class UnsupportedTransportError extends Error {
  constructor(transport: string) {
    super(`MCP transport '${transport}' is not supported by the gateway. Only streamable_http is supported.`);
    this.name = "UnsupportedTransportError";
  }
}

export class CircuitOpenError extends Error {
  constructor(serverId: string) {
    super(`MCP client circuit open for server ${serverId}: too many consecutive failures. Retry after 60 s.`);
    this.name = "CircuitOpenError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PooledClient {
  /** Opaque MCP client — typed as `any` to avoid pulling in the full SDK at
   *  the type level in modules that only need the pool interface. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transport: any;
  serverId: string;
  companyId: string;
  connectedAt: number;
  consecutiveFails: number;
  toolList: ToolListResult;
}

export interface ToolListResult {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const REUSE_TTL_MS = 15 * 60 * 1000; // 15 min
const CIRCUIT_OPEN_DURATION_MS = 60 * 1000; // 60 s
const MAX_CONSECUTIVE_FAILS = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const LIST_TOOLS_TIMEOUT_MS = 15_000;

const _pool = new Map<string, PooledClient>();
const _circuitOpenUntil = new Map<string, number>();

// Test-only injection: replace the factory used to create new clients.
type ClientFactory = (
  db: Db,
  server: { id: string; endpoint: string; authToken: string | null; companyId: string; serverId: string },
) => Promise<PooledClient>;

let _clientFactory: ClientFactory | null = null;

/** Override the client factory for unit tests. */
export function _setClientFactoryForTesting(factory: ClientFactory | null): void {
  _clientFactory = factory;
  _pool.clear();
  _circuitOpenUntil.clear();
}

/** Reset pool state between tests. */
export function _resetClientPoolForTesting(): void {
  _pool.clear();
  _circuitOpenUntil.clear();
  _clientFactory = null;
}

// ---------------------------------------------------------------------------
// Default factory: real MCP SDK
// ---------------------------------------------------------------------------

async function defaultClientFactory(
  db: Db,
  server: { id: string; endpoint: string; authToken: string | null; companyId: string; serverId: string },
): Promise<PooledClient> {
  // Dynamic import so the SDK isn't loaded at module init time (keeps cold-start fast).
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const requestInit: RequestInit = server.authToken
    ? { headers: { Authorization: `Bearer ${server.authToken}` } }
    : {};

  const transport = new StreamableHTTPClientTransport(new URL(server.endpoint), { requestInit });

  const client = new Client({ name: "paperclip-mcp-gateway", version: "0.1.0" }, {});

  await Promise.race([
    client.connect(transport),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("MCP connect timeout")), CONNECT_TIMEOUT_MS),
    ),
  ]);

  const toolList = await Promise.race([
    client.listTools(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("MCP listTools timeout")), LIST_TOOLS_TIMEOUT_MS),
    ),
  ]) as ToolListResult;

  return {
    client,
    transport,
    serverId: server.serverId,
    companyId: server.companyId,
    connectedAt: Date.now(),
    consecutiveFails: 0,
    toolList,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function acquireClient(
  db: Db,
  companyId: string,
  serverId: string,
): Promise<PooledClient> {
  const key = `${companyId}:${serverId}`;

  // Check circuit breaker
  const openUntil = _circuitOpenUntil.get(key);
  if (openUntil !== undefined && Date.now() < openUntil) {
    throw new CircuitOpenError(serverId);
  }

  // Check cached client
  const cached = _pool.get(key);
  if (cached && Date.now() - cached.connectedAt < REUSE_TTL_MS) {
    return cached;
  }

  // Tear down old client if expired
  if (cached) {
    _pool.delete(key);
    try {
      await cached.transport.close?.();
    } catch {
      // best-effort
    }
  }

  // When a test factory is injected, skip DB lookup and auth resolution —
  // the factory receives stub values and returns a pre-configured fake client.
  if (_clientFactory) {
    try {
      const pooled = await _clientFactory(db, {
        id: serverId,
        endpoint: "",
        authToken: null,
        companyId,
        serverId,
      });
      pooled.serverId = serverId;
      pooled.companyId = companyId;
      _pool.set(key, pooled);
      _circuitOpenUntil.delete(key);
      return pooled;
    } catch (err) {
      const fails = 1;
      if (fails >= MAX_CONSECUTIVE_FAILS) {
        _circuitOpenUntil.set(key, Date.now() + CIRCUIT_OPEN_DURATION_MS);
      }
      throw err;
    }
  }

  // Look up server row
  const serverRow = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, serverId), eq(mcpServers.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!serverRow) {
    throw new Error(`MCP server ${serverId} not found in company ${companyId}`);
  }

  if (serverRow.transport !== "streamable_http") {
    throw new UnsupportedTransportError(serverRow.transport);
  }

  // Resolve auth token if needed
  let authToken: string | null = null;
  if (serverRow.authType === "bearer_ref" && serverRow.authSecretRef) {
    authToken = await secretService(db).resolveSecretValue(
      companyId,
      serverRow.authSecretRef,
      "latest",
    );
  } else if (serverRow.authType === "oauth_ref" || serverRow.authType === "signed_jwt") {
    // TODO: implement OAuth and signed JWT auth flows
    throw new UnsupportedTransportError(`authType=${serverRow.authType}`);
  }

  try {
    const pooled = await defaultClientFactory(db, {
      id: serverRow.id,
      endpoint: serverRow.endpoint,
      authToken,
      companyId,
      serverId,
    });
    pooled.serverId = serverId;
    pooled.companyId = companyId;
    _pool.set(key, pooled);
    _circuitOpenUntil.delete(key);
    return pooled;
  } catch (err) {
    const existing = _pool.get(key);
    const fails = (existing?.consecutiveFails ?? 0) + 1;
    if (fails >= MAX_CONSECUTIVE_FAILS) {
      _circuitOpenUntil.set(key, Date.now() + CIRCUIT_OPEN_DURATION_MS);
    }
    throw err;
  }
}

export async function releaseAllForCompany(companyId: string): Promise<void> {
  for (const [key, client] of _pool.entries()) {
    if (client.companyId === companyId) {
      _pool.delete(key);
      try {
        await client.transport.close?.();
      } catch {
        // best-effort
      }
    }
  }
}
