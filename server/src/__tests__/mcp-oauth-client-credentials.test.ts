/**
 * Tests for the OAuth 2.1 Client Credentials flow in the MCP client pool.
 *
 * All network calls are mocked via vi.stubGlobal('fetch', ...) so no real
 * upstream server is needed.  The MCP SDK client factory is replaced with a
 * lightweight stub via _setClientFactoryForTesting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireClient,
  OAuthTokenRefreshError,
  OAuthCredentialMissingError,
  _resetClientPoolForTesting,
} from "../services/mcp/client-pool.js";

// ---------------------------------------------------------------------------
// Drizzle-aware DB mock (same pattern as mcp-gateway.test.ts)
// ---------------------------------------------------------------------------

const DRIZZLE_NAME_SYMBOL = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  if (!table || typeof table !== "object") return "unknown";
  const name = (table as Record<symbol, unknown>)[DRIZZLE_NAME_SYMBOL];
  return typeof name === "string" ? name : "unknown";
}

type DbRow = Record<string, unknown>;

function createMockDb(serverRow: DbRow) {
  function select() {
    const query = {
      _tableName: "unknown",
      from(table: unknown) {
        this._tableName = getTableName(table);
        return this;
      },
      where() { return this; },
      then(resolve: (rows: DbRow[]) => unknown) {
        const rows = this._tableName === "mcp_servers" ? [serverRow] : [];
        return Promise.resolve(resolve(rows));
      },
    };
    return query;
  }

  return { select } as unknown as import("@paperclipai/db").Db;
}

function createEmptyMockDb() {
  function select() {
    const query = {
      _tableName: "unknown",
      from(table: unknown) {
        this._tableName = getTableName(table);
        return this;
      },
      where() { return this; },
      then(resolve: (rows: DbRow[]) => unknown) {
        return Promise.resolve(resolve([]));
      },
    };
    return query;
  }
  return { select } as unknown as import("@paperclipai/db").Db;
}

// ---------------------------------------------------------------------------
// Secret service mock
// ---------------------------------------------------------------------------

// Control the secret value returned by the mock per-test
let _secretValueOverride: string | null = null;

vi.mock("../services/secrets.js", () => ({
  secretService: (_db: unknown) => ({
    resolveSecretValue: vi.fn().mockImplementation(() => {
      if (_secretValueOverride !== null) {
        const value = _secretValueOverride;
        _secretValueOverride = null; // one-shot
        return Promise.resolve(value);
      }
      return Promise.resolve(
        JSON.stringify({ client_id: "test-client-id", client_secret: "test-client-secret" }),
      );
    }),
  }),
}));

// ---------------------------------------------------------------------------
// MCP SDK mock — lightweight stub that records connect() calls
// ---------------------------------------------------------------------------

const connectCalls: string[] = [];
const mockTransport = { close: vi.fn().mockResolvedValue(undefined) };

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockImplementation((_transport: unknown) => {
      connectCalls.push("connect");
      return Promise.resolve();
    }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation((_url: unknown, opts: { requestInit?: { headers?: Record<string, string> } }) => ({
    ...mockTransport,
    _authHeader: (opts?.requestInit?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null,
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_ENDPOINT = "https://auth.example.com/oauth/token";
const MCP_ENDPOINT = "https://mcp.example.com/api";
const COMPANY_ID = "company-uuid";
const SERVER_ID = "server-uuid";

function makeServerRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: SERVER_ID,
    companyId: COMPANY_ID,
    transport: "streamable_http",
    endpoint: MCP_ENDPOINT,
    authType: "oauth_ref",
    authSecretRef: "secret-uuid",
    oauthTokenEndpoint: TOKEN_ENDPOINT,
    oauthScopes: "mcp:tools mcp:resources",
    oauthResource: null, // will default to endpoint
    ...overrides,
  };
}

function mockTokenFetch(opts: {
  status?: number;
  body?: unknown;
  notJson?: boolean;
} = {}) {
  const { status = 200, body, notJson = false } = opts;
  const responseBody = notJson
    ? "not-json-response"
    : JSON.stringify(body ?? {
        access_token: "ya29.first-token",
        token_type: "Bearer",
        expires_in: 3600,
      });

  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(responseBody),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP OAuth Client Credentials", () => {
  beforeEach(() => {
    _resetClientPoolForTesting();
    connectCalls.length = 0;
    vi.unstubAllGlobals();
    delete process.env.PAPERCLIP_MCP_OAUTH_DISABLED;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PAPERCLIP_MCP_OAUTH_DISABLED;
  });

  // -------------------------------------------------------------------------
  // Test 1: First connect runs client-credentials flow
  // -------------------------------------------------------------------------

  it("first connect: fetches token via client_credentials and carries Bearer header", async () => {
    const fetchMock = mockTokenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const db = createMockDb(makeServerRow());
    const pooled = await acquireClient(db, COMPANY_ID, SERVER_ID);

    // token endpoint was called once
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init.method).toBe("POST");

    // grant_type and resource indicator are present
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("resource")).toBe(MCP_ENDPOINT); // defaults to endpoint since oauthResource=null
    expect(body.get("scope")).toBe("mcp:tools mcp:resources");

    // token is cached on the pool entry
    expect(pooled.oauthAccessToken).toBe("ya29.first-token");
    expect(pooled.oauthExpiresAt).toBeGreaterThan(Date.now());
  });

  // -------------------------------------------------------------------------
  // Test 2: Second call reuses cached token — no new POST
  // -------------------------------------------------------------------------

  it("second acquireClient reuses cached token without calling the token endpoint", async () => {
    const fetchMock = mockTokenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const db = createMockDb(makeServerRow());

    await acquireClient(db, COMPANY_ID, SERVER_ID);
    const fetchCallsAfterFirst = fetchMock.mock.calls.length;

    await acquireClient(db, COMPANY_ID, SERVER_ID);

    // No additional fetch calls
    expect(fetchMock.mock.calls.length).toBe(fetchCallsAfterFirst);
  });

  // -------------------------------------------------------------------------
  // Test 3: Expired token triggers refresh
  // -------------------------------------------------------------------------

  it("expired token triggers a new token fetch on the next acquireClient", async () => {
    let tokenCounter = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      tokenCounter += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          access_token: `token-${tokenCounter}`,
          token_type: "Bearer",
          expires_in: 3600,
        })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const db = createMockDb(makeServerRow());

    // First connect
    const first = await acquireClient(db, COMPANY_ID, SERVER_ID);
    expect(first.oauthAccessToken).toBe("token-1");

    // Manually expire the token
    first.oauthExpiresAt = Date.now() - 1;

    // Second call should refresh
    const second = await acquireClient(db, COMPANY_ID, SERVER_ID);
    expect(second.oauthAccessToken).toBe("token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Test 4: Token endpoint returns 401 → OAuthTokenRefreshError
  // -------------------------------------------------------------------------

  it("token endpoint 401 throws OAuthTokenRefreshError", async () => {
    vi.stubGlobal("fetch", mockTokenFetch({ status: 401, body: { error: "unauthorized_client" } }));

    const db = createMockDb(makeServerRow());

    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(OAuthTokenRefreshError);
    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(/HTTP 401/);
  });

  // -------------------------------------------------------------------------
  // Test 5: Token endpoint returns non-JSON → OAuthTokenRefreshError
  // -------------------------------------------------------------------------

  it("token endpoint non-JSON body throws OAuthTokenRefreshError", async () => {
    vi.stubGlobal("fetch", mockTokenFetch({ notJson: true }));

    const db = createMockDb(makeServerRow());

    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(OAuthTokenRefreshError);
  });

  // -------------------------------------------------------------------------
  // Test 6: Secret JSON missing client_secret → OAuthCredentialMissingError
  // -------------------------------------------------------------------------

  it("secret JSON missing client_secret throws OAuthCredentialMissingError", async () => {
    // Set the one-shot override to a JSON blob without client_secret
    _secretValueOverride = JSON.stringify({ client_id: "test-id" });

    vi.stubGlobal("fetch", mockTokenFetch());

    const db = createMockDb(makeServerRow());

    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(OAuthCredentialMissingError);
    // Reset state for next assertion in same test
    _secretValueOverride = JSON.stringify({ client_id: "test-id" });
    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(/client_secret/);
  });

  // -------------------------------------------------------------------------
  // Test 7: Kill switch — PAPERCLIP_MCP_OAUTH_DISABLED=true
  // -------------------------------------------------------------------------

  it("PAPERCLIP_MCP_OAUTH_DISABLED=true throws 'OAuth disabled by operator'", async () => {
    process.env.PAPERCLIP_MCP_OAUTH_DISABLED = "true";
    vi.stubGlobal("fetch", mockTokenFetch());

    const db = createMockDb(makeServerRow());

    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(/OAuth disabled by operator/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8: RFC 8707 resource param matches oauthResource when set
  // -------------------------------------------------------------------------

  it("RFC 8707: resource param on token POST matches oauthResource when explicitly set", async () => {
    const fetchMock = mockTokenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const customResource = "https://api.example.com/mcp-resource";
    const db = createMockDb(makeServerRow({ oauthResource: customResource }));

    await acquireClient(db, COMPANY_ID, SERVER_ID);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("resource")).toBe(customResource);
  });

  // -------------------------------------------------------------------------
  // Test 8b: RFC 8707: resource defaults to endpoint when oauthResource is null
  // -------------------------------------------------------------------------

  it("RFC 8707: resource defaults to endpoint URL when oauthResource is null", async () => {
    const fetchMock = mockTokenFetch();
    vi.stubGlobal("fetch", fetchMock);

    const db = createMockDb(makeServerRow({ oauthResource: null }));

    await acquireClient(db, COMPANY_ID, SERVER_ID);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("resource")).toBe(MCP_ENDPOINT);
  });

  // -------------------------------------------------------------------------
  // Test 9: Token-refresh rate cap — 4 rapid failures → only 3 fetch attempts
  // -------------------------------------------------------------------------

  it("token-refresh rate cap: after 3 failures the 4th attempt throws without calling fetch", async () => {
    // Make the token endpoint always fail
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve(JSON.stringify({ error: "service_unavailable" })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const db = createMockDb(makeServerRow());

    // Attempt 1
    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(OAuthTokenRefreshError);
    // Attempt 2
    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(OAuthTokenRefreshError);
    // Attempt 3
    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(OAuthTokenRefreshError);
    // Attempt 4 — should throw rate-cap error WITHOUT calling fetch
    const fetchCallsBefore = fetchMock.mock.calls.length;
    await expect(acquireClient(db, COMPANY_ID, SERVER_ID)).rejects.toThrow(/rate cap exceeded/i);
    expect(fetchMock.mock.calls.length).toBe(fetchCallsBefore); // no additional fetch call
  });
});
