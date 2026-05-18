/**
 * MCP client pool: one connected upstream client per (companyId, serverId).
 *
 * Clients are reused for up to 15 minutes. A simple circuit-breaker refuses
 * acquire for 60 s after 3 consecutive failures.
 *
 * Only `transport=streamable_http` is supported in this commit.
 * stdio / sse_legacy throw `UnsupportedTransportError`.
 *
 * Auth types:
 *   none       — no Authorization header
 *   bearer_ref — static bearer token from company_secrets
 *   oauth_ref  — OAuth 2.1 Client Credentials flow with RFC 8707 resource indicator
 *   signed_jwt — NOT YET IMPLEMENTED (throws UnsupportedTransportError)
 *                TODO: implement signed JWT upstream auth
 */
import type { Db } from "@paperclipai/db";
import { mcpServers } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { secretService } from "../secrets.js";
import { logger } from "../../middleware/logger.js";

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

function isOAuthDisabled(): boolean {
  return process.env.PAPERCLIP_MCP_OAUTH_DISABLED === "true";
}

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

/**
 * Thrown when the upstream OAuth token endpoint returns an error or an
 * unexpected response shape. Wraps the upstream failure so callers can
 * distinguish auth failures from generic transport errors.
 */
export class OAuthTokenRefreshError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "OAuthTokenRefreshError";
  }
}

export class OAuthCredentialMissingError extends Error {
  constructor(field: "client_id" | "client_secret") {
    super(`OAuth secret JSON is missing required field: ${field}`);
    this.name = "OAuthCredentialMissingError";
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
  /** Cached OAuth access token (only set when authType='oauth_ref') */
  oauthAccessToken?: string;
  /** Expiry epoch ms for the cached token (with 60 s safety buffer already applied) */
  oauthExpiresAt?: number;
}

export interface ToolListResult {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// OAuth token-refresh rate cap
// ---------------------------------------------------------------------------

interface RefreshRecord {
  attempts: number;
  windowStart: number;
}

const REFRESH_WINDOW_MS = 60_000; // 60 s
const MAX_REFRESH_ATTEMPTS = 3;

const _refreshRecords = new Map<string, RefreshRecord>();

function checkAndRecordRefreshAttempt(key: string): void {
  const now = Date.now();
  const record = _refreshRecords.get(key);

  if (!record || now - record.windowStart > REFRESH_WINDOW_MS) {
    // Start a new window
    _refreshRecords.set(key, { attempts: 1, windowStart: now });
    return;
  }

  if (record.attempts >= MAX_REFRESH_ATTEMPTS) {
    throw new OAuthTokenRefreshError(
      `OAuth token refresh rate cap exceeded for server (${MAX_REFRESH_ATTEMPTS} attempts in 60 s). Marking degraded.`,
    );
  }

  record.attempts += 1;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const REUSE_TTL_MS = 15 * 60 * 1000; // 15 min
const CIRCUIT_OPEN_DURATION_MS = 60 * 1000; // 60 s
const MAX_CONSECUTIVE_FAILS = 3;
const CONNECT_TIMEOUT_MS = 10_000;
const LIST_TOOLS_TIMEOUT_MS = 15_000;
/** Safety buffer before token expiry: refresh 60 s early */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

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
  _refreshRecords.clear();
}

/** Reset pool state between tests. */
export function _resetClientPoolForTesting(): void {
  _pool.clear();
  _circuitOpenUntil.clear();
  _refreshRecords.clear();
  _clientFactory = null;
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

interface OAuthClientCredentials {
  client_id: string;
  client_secret: string;
}

function parseOAuthCredentials(rawJson: string): OAuthClientCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new OAuthTokenRefreshError("OAuth secret value is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OAuthTokenRefreshError("OAuth secret JSON must be an object");
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.client_id !== "string" || !obj.client_id) {
    throw new OAuthCredentialMissingError("client_id");
  }
  if (typeof obj.client_secret !== "string" || !obj.client_secret) {
    throw new OAuthCredentialMissingError("client_secret");
  }

  return { client_id: obj.client_id, client_secret: obj.client_secret };
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

/**
 * Fetch an OAuth 2.1 Client Credentials access token.
 *
 * RFC 8707 resource indicator is sent as the `resource` parameter so the
 * authorization server can bind the issued token to the target MCP server's
 * endpoint URL.
 *
 * NEVER logs access_token or client_secret.
 */
async function fetchOAuthToken(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string | null;
  resource: string;
  poolKey: string;
}): Promise<{ accessToken: string; expiresAt: number }> {
  const { tokenEndpoint, clientId, clientSecret, scopes, resource, poolKey } = opts;

  // Rate cap: max 3 refresh attempts per 60 s
  checkAndRecordRefreshAttempt(poolKey);

  logger.info(
    { tokenEndpoint, scopes, resource },
    "mcp-oauth: fetching client credentials token",
  );

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    resource,
  });

  if (scopes) {
    body.set("scope", scopes);
  }

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    try {
      response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    throw new OAuthTokenRefreshError(
      `OAuth token request failed (network error): ${err instanceof Error ? err.name : "unknown"}`,
      err,
    );
  }

  if (!response.ok) {
    throw new OAuthTokenRefreshError(
      `OAuth token endpoint returned HTTP ${response.status} for resource ${resource}`,
    );
  }

  let tokenResponse: OAuthTokenResponse;
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).access_token !== "string"
    ) {
      throw new Error("missing access_token");
    }
    tokenResponse = parsed as OAuthTokenResponse;
  } catch (err) {
    throw new OAuthTokenRefreshError(
      `OAuth token endpoint returned non-JSON or invalid body: ${err instanceof Error ? err.message : "unknown"}`,
      err,
    );
  }

  const expiresInMs = typeof tokenResponse.expires_in === "number" && tokenResponse.expires_in > 0
    ? tokenResponse.expires_in * 1000
    : 3_600_000; // default 1h

  // Apply safety buffer so we refresh before expiry
  const expiresAt = Date.now() + expiresInMs - TOKEN_EXPIRY_BUFFER_MS;

  logger.info({ tokenEndpoint, resource, expiresInMs }, "mcp-oauth: token obtained");

  return { accessToken: tokenResponse.access_token, expiresAt };
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

/**
 * Build a new MCP client using an OAuth-obtained access token.
 * Re-opens the transport with the fresh token rather than updating headers
 * in-place (StreamableHTTPClientTransport takes headers in its constructor).
 */
async function oauthClientFactory(opts: {
  endpoint: string;
  accessToken: string;
  serverId: string;
  companyId: string;
}): Promise<Omit<PooledClient, "oauthAccessToken" | "oauthExpiresAt">> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const requestInit: RequestInit = {
    headers: { Authorization: `Bearer ${opts.accessToken}` },
  };

  const transport = new StreamableHTTPClientTransport(new URL(opts.endpoint), { requestInit });
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
    serverId: opts.serverId,
    companyId: opts.companyId,
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
    // For oauth_ref: check whether the cached token is still valid
    if (cached.oauthAccessToken && cached.oauthExpiresAt !== undefined) {
      if (Date.now() < cached.oauthExpiresAt) {
        // Token still valid — reuse as-is
        return cached;
      }
      // Token expired — fall through to refresh path below (don't return)
      // but we still want the server row so we fall through the rest of
      // the function.  Close the old transport best-effort.
      _pool.delete(key);
      try {
        await cached.transport.close?.();
      } catch {
        // best-effort
      }
    } else {
      // No OAuth token required — plain reuse
      return cached;
    }
  } else if (cached) {
    // TTL expired
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

  try {
    let pooled: PooledClient;

    if (serverRow.authType === "none") {
      // -----------------------------------------------------------------------
      // No auth
      // -----------------------------------------------------------------------
      pooled = await defaultClientFactory(db, {
        id: serverRow.id,
        endpoint: serverRow.endpoint,
        authToken: null,
        companyId,
        serverId,
      });

    } else if (serverRow.authType === "bearer_ref") {
      // -----------------------------------------------------------------------
      // Static bearer token from company_secrets
      // -----------------------------------------------------------------------
      const authToken = serverRow.authSecretRef
        ? await secretService(db).resolveSecretValue(
            companyId,
            serverRow.authSecretRef,
            "latest",
          )
        : null;

      pooled = await defaultClientFactory(db, {
        id: serverRow.id,
        endpoint: serverRow.endpoint,
        authToken,
        companyId,
        serverId,
      });

    } else if (serverRow.authType === "oauth_ref") {
      // -----------------------------------------------------------------------
      // OAuth 2.1 Client Credentials with RFC 8707 resource indicator
      // -----------------------------------------------------------------------
      if (isOAuthDisabled()) {
        throw new Error("OAuth disabled by operator (PAPERCLIP_MCP_OAUTH_DISABLED=true)");
      }

      if (!serverRow.authSecretRef) {
        throw new Error(`MCP server ${serverId} has authType='oauth_ref' but no authSecretRef`);
      }
      if (!serverRow.oauthTokenEndpoint) {
        throw new Error(`MCP server ${serverId} has authType='oauth_ref' but no oauthTokenEndpoint`);
      }

      // Resolve client credentials from the secret JSON blob
      const rawSecret = await secretService(db).resolveSecretValue(
        companyId,
        serverRow.authSecretRef,
        "latest",
      );
      const credentials = parseOAuthCredentials(rawSecret);

      // RFC 8707: resource indicator defaults to the MCP endpoint base URL
      const resource = serverRow.oauthResource ?? serverRow.endpoint;

      const { accessToken, expiresAt } = await fetchOAuthToken({
        tokenEndpoint: serverRow.oauthTokenEndpoint,
        clientId: credentials.client_id,
        clientSecret: credentials.client_secret,
        scopes: serverRow.oauthScopes ?? null,
        resource,
        poolKey: key,
      });

      const oauthConn = await oauthClientFactory({
        endpoint: serverRow.endpoint,
        accessToken,
        serverId,
        companyId,
      });

      pooled = {
        ...oauthConn,
        oauthAccessToken: accessToken,
        oauthExpiresAt: expiresAt,
      };

    } else if (serverRow.authType === "signed_jwt") {
      // -----------------------------------------------------------------------
      // signed_jwt — NOT YET IMPLEMENTED
      // TODO: implement signed JWT upstream auth (RFC 7523 / MTLS bound tokens)
      // -----------------------------------------------------------------------
      throw new UnsupportedTransportError(`authType=${serverRow.authType}`);

    } else {
      throw new UnsupportedTransportError(`authType=${serverRow.authType}`);
    }

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
