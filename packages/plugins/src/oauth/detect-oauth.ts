/**
 * detect-oauth.ts — probe whether a remote MCP endpoint is protected by
 * OAuth 2.1 (RFC 9728 protected-resource metadata / MCP authorization spec).
 *
 * The MCP registry's server.json format cannot express "this server uses
 * OAuth" — deriveAuthKind() only ever yields "secret" (declared secret
 * headers) or "none". OAuth protection is only discoverable live: a protected
 * server either publishes /.well-known/oauth-protected-resource (RFC 9728) or
 * answers an unauthenticated request with 401. This helper runs at install
 * time so the listing is stored with authKind "oauth" and the UI can prompt
 * the user to authenticate immediately instead of failing silently at agent
 * runtime.
 *
 * Never throws — a probe failure (offline server, timeout, bad JSON) returns
 * false and the install proceeds with the registry-derived authKind.
 *
 * SSRF: `endpointUrl` is user-supplied (a custom MCP server URL, or a registry
 * record), and this function issues a server-side GET (redirects followed) plus
 * a POST to it. `http:` is accepted, so nothing here stops a probe of a private
 * or link-local address. Every caller that can be reached by an untrusted URL
 * MUST pass a `fetchFn` that blocks private ranges — the app's
 * `@/lib/mcp-oauth/safe-fetch` is the one to use.
 */

export interface DetectOAuthOptions {
  /**
   * Fetch implementation. Defaults to global fetch, which applies NO
   * private-address filtering — see the SSRF note above before relying on the
   * default with an untrusted endpoint.
   */
  fetchFn?: typeof fetch;
  /** Per-request timeout in milliseconds. Default 3000. */
  timeoutMs?: number;
}

/**
 * RFC 9728 §3.1: the well-known URI is formed by inserting
 * `/.well-known/oauth-protected-resource` between the host and the resource
 * path. A server may also serve it at the origin root regardless of the
 * resource path, so both candidates are probed (path-aware first).
 */
export function wellKnownCandidates(endpointUrl: string): string[] {
  const url = new URL(endpointUrl);
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") return [root];
  return [`${root}${path}`, root];
}

interface ProtectedResourceMetadata {
  resource?: unknown;
  authorization_servers?: unknown;
}

function isProtectedResourceMetadata(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as ProtectedResourceMetadata;
  // authorization_servers present and non-empty is the definitive signal; a
  // bare `resource` echo without any AS entries cannot start an OAuth flow.
  return (
    Array.isArray(meta.authorization_servers) &&
    meta.authorization_servers.length > 0
  );
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Returns true when the endpoint is OAuth-protected: it publishes RFC 9728
 * protected-resource metadata naming at least one authorization server, or it
 * rejects an unauthenticated MCP initialize with 401.
 */
export async function detectOAuthProtected(
  endpointUrl: string,
  opts: DetectOAuthOptions = {},
): Promise<boolean> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;

  let candidates: string[];
  try {
    const parsed = new URL(endpointUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return false;
    candidates = wellKnownCandidates(endpointUrl);
  } catch {
    return false;
  }

  // ── 1. RFC 9728 protected-resource metadata ─────────────────────────────────
  for (const wellKnown of candidates) {
    try {
      const resp = await fetchWithTimeout(
        fetchFn,
        wellKnown,
        {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "follow",
        },
        timeoutMs,
      );
      if (resp.ok) {
        const body: unknown = await resp.json().catch(() => null);
        if (isProtectedResourceMetadata(body)) return true;
      }
    } catch {
      // Timeout / network error on the well-known probe — fall through.
    }
  }

  // ── 2. Unauthenticated initialize → 401 challenge ───────────────────────────
  // Streamable-HTTP servers that skip RFC 9728 still challenge with 401 (the
  // MCP authorization spec's discovery entry point). Any 401 here means the
  // server demands authorization it was not given — for remote MCP servers
  // that is the OAuth flow.
  try {
    const resp = await fetchWithTimeout(
      fetchFn,
      endpointUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "oxagen-auth-probe", version: "1.0.0" },
          },
        }),
        redirect: "follow",
      },
      timeoutMs,
    );
    // Drain the body so undici can reuse the connection; ignore its content.
    await resp.body?.cancel().catch(() => undefined);
    return resp.status === 401;
  } catch {
    return false;
  }
}
