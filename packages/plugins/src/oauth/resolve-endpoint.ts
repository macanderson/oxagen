/**
 * resolve-endpoint.ts — resolves HTTP redirects on an MCP endpoint URL before
 * OAuth discovery runs against it.
 *
 * Registry metadata sometimes publishes a vanity/apex URL that 301s to the
 * real MCP endpoint (e.g. https://sh.inference.ac → https://api.inference.sh/mcp).
 * RFC 9728 discovery against the vanity origin then probes the WRONG host's
 * well-known documents and the flow fails with an unparseable provider error.
 * Resolving the redirect chain first — and self-healing the stored listing —
 * makes discovery run against the host that actually serves MCP.
 *
 * Never throws: any network error, redirect loop, or unsafe target returns
 * the last known-good URL so the caller proceeds exactly as before.
 *
 * SSRF: `isSafeTarget` only checks the SCHEME (https, or http on a literal
 * localhost/127.0.0.1). It does not resolve DNS or reject private ranges, so an
 * `https://` redirect into 10.0.0.0/8 or 169.254.169.254 is followed. Callers
 * reachable by an untrusted URL must pass a `fetchFn` that blocks private
 * addresses — the app's `@/lib/mcp-oauth/safe-fetch` is the one to use.
 */

export interface ResolveEndpointOptions {
  /**
   * Injection seam for tests / Next.js fetch wrappers. Only string inputs are
   * ever passed, so any fetch-shaped function (global fetch, the MCP SDK's
   * FetchLike) is assignable. Defaults to global fetch.
   */
  fetchFn?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Maximum redirect hops to follow. Default 3. */
  maxHops?: number;
  /** Per-request timeout in milliseconds. Default 5000. */
  timeoutMs?: number;
}

/** A redirect target is followed only onto https (or http on localhost, for dev). */
function isSafeTarget(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

/**
 * Follows 3xx redirects from `endpointUrl` (GET, redirect: "manual") and
 * returns the final non-redirecting URL. Cross-origin hops are allowed — that
 * is the mis-published-registry-endpoint case this exists for — but only onto
 * safe (https / localhost) targets.
 */
export async function resolveEndpointRedirects(
  endpointUrl: string,
  opts: ResolveEndpointOptions = {},
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxHops = opts.maxHops ?? 3;
  const timeoutMs = opts.timeoutMs ?? 5000;

  let current: URL;
  try {
    current = new URL(endpointUrl);
    if (!isSafeTarget(current)) return endpointUrl;
  } catch {
    return endpointUrl;
  }

  for (let hop = 0; hop < maxHops; hop++) {
    let resp: Response;
    try {
      resp = await fetchFn(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/json, text/event-stream" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return current.toString();
    }
    // Drain whatever body exists so undici can reuse the connection.
    await resp.body?.cancel().catch(() => undefined);

    if (resp.status < 300 || resp.status >= 400) return current.toString();

    const location = resp.headers.get("location");
    if (!location) return current.toString();

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return current.toString();
    }
    if (!isSafeTarget(next)) return current.toString();
    current = next;
  }
  return current.toString();
}
