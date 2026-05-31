/**
 * Curated catalog of well-known, trusted upstream MCP servers an operator
 * can register into their company with one confirmation, rather than typing
 * the endpoint/transport/auth by hand.
 *
 * These are SUGGESTIONS, not auto-registrations. Many require an API key the
 * operator must supply (stored as a company secret), so we cannot create the
 * mcp_servers row unattended. The flow is:
 *
 *   1. UI lists suggestions via GET /companies/:companyId/mcp/suggestions,
 *      annotating which are already registered (by name collision).
 *   2. Operator picks one; the UI pre-fills the create-server form with the
 *      suggestion's defaults (transport, endpoint, authType, the secret it
 *      needs), and they supply the secret ref.
 *   3. POST /companies/:companyId/mcp/suggestions/:key/install creates the
 *      mcp_servers row from the template + the operator-supplied authSecretRef.
 *
 * Adding a new suggestion is a one-line entry below — no schema change.
 */

export interface McpServerSuggestion {
  /** Stable catalog key (used in the install route). */
  key: string;
  /** The name the registered mcp_servers row will get (also the collision key). */
  name: string;
  /** One-line description shown in the UI. */
  description: string;
  /** Default transport for the registration. */
  transport: "streamable_http" | "sse_legacy" | "stdio";
  /** Upstream MCP endpoint URL (or command for stdio). */
  endpoint: string;
  /**
   * Auth model the upstream requires. When 'bearer_ref' or 'oauth_ref', the
   * operator must supply an authSecretRef at install time (we cannot ship a
   * shared key). 'none' installs unattended.
   */
  authType: "none" | "bearer_ref" | "oauth_ref" | "signed_jwt";
  /**
   * Human guidance shown next to the secret field when authType != 'none'.
   * e.g. "Create a company secret holding your Perplexity API key."
   */
  authHint?: string;
  /** Provider/vendor homepage or docs for the operator to learn more. */
  docsUrl: string;
  /** Vendor/source reputation note for operator trust. */
  source: string;
}

/**
 * The catalog. Curated, deliberately small, every entry first-party and
 * widely trusted. Perplexity is the first per the 2026-05-30 CLI audit.
 */
export const MCP_SERVER_SUGGESTIONS: readonly McpServerSuggestion[] = [
  {
    key: "perplexity-sonar",
    name: "perplexity",
    description:
      "Perplexity's official MCP server — real-time web search, reasoning, and research via Sonar models. Self-hosted: run the server (npm or Docker, listens on :8080/mcp) with your PERPLEXITY_API_KEY, then register its URL here.",
    transport: "streamable_http",
    // Perplexity's MCP server is self-hosted (github.com/perplexityai/modelcontextprotocol),
    // listening on http://<host>:8080/mcp by default. There is no first-party
    // hosted SaaS endpoint as of 2026-05-30, so the operator edits this URL to
    // point at their own deployment. The Perplexity API key is supplied to that
    // server via its PERPLEXITY_API_KEY env var — NOT forwarded by the gateway —
    // so the gateway auth type is 'none'.
    endpoint: "http://localhost:8080/mcp",
    authType: "none",
    authHint:
      "No gateway auth needed: the Perplexity MCP server holds your PERPLEXITY_API_KEY itself. Edit the endpoint to point at your deployed server (default http://<host>:8080/mcp).",
    docsUrl: "https://github.com/perplexityai/modelcontextprotocol",
    source: "Perplexity AI (first-party, self-hosted)",
  },
] as const;

export function listMcpServerSuggestions(): readonly McpServerSuggestion[] {
  return MCP_SERVER_SUGGESTIONS;
}

export function getMcpServerSuggestion(key: string): McpServerSuggestion | null {
  return MCP_SERVER_SUGGESTIONS.find((s) => s.key === key) ?? null;
}
