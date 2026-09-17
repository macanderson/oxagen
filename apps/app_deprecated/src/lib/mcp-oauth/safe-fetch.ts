/**
 * safe-fetch.ts — the single, timeout-bounded `fetch` wrapper handed to the
 * MCP SDK's `mcpAuth` / `resolveEndpointRedirects` during the OAuth authorize
 * and callback flows.
 *
 * Both the authorize and callback route handlers drive the MCP SDK against an
 * ARBITRARY third-party authorization server (whatever endpoint a listing
 * publishes). That server is the flakiest dependency in the whole flow: it can
 * be slow, hang after accepting the TCP connection, or be down entirely. Two
 * behaviours must be guaranteed regardless of how it misbehaves:
 *
 *  1. TIMEOUT (P0). A raw `fetch` has NO timeout — a server that accepts the
 *     connection but never responds would block the serverless function until
 *     the platform's hard invocation limit (tens of seconds to minutes),
 *     pinning a function slot and a DB connection the entire time, per
 *     well-known probe. `mcpAuth` makes several of these sequentially, so the
 *     stall compounds. We bound every request with `AbortSignal.timeout` and,
 *     when the caller also passes a signal, race both via `AbortSignal.any`
 *     so an upstream cancel still wins.
 *
 *  2. NEXT PATCHED-FETCH WORKAROUNDS. `cache: "no-store"` bypasses Next's
 *     per-URL dedup locks (the SDK's sequential well-known fetches can deadlock
 *     on the lock held by the previous request). Pre-draining a non-OK body and
 *     returning a plain Response makes the SDK's `body.cancel()` on a 404
 *     (from `/.well-known/oauth-protected-resource`) a synchronous no-op
 *     instead of a call that can block indefinitely on the patched Response.
 *
 * Extracted here so the authorize and callback routes share ONE implementation
 * — the two previously-duplicated copies had drifted and neither had a timeout.
 */
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { logger } from "@oxagen/handlers/logger";

/**
 * Per-request timeout for a single well-known / token-endpoint fetch, in ms.
 * Each `mcpAuth` call issues several requests sequentially; this bounds each
 * one so a hung server can never stall the flow past a few of these. Overridable
 * via `MCP_OAUTH_FETCH_TIMEOUT_MS` for slow-but-legitimate providers.
 */
export const DEFAULT_MCP_OAUTH_FETCH_TIMEOUT_MS = 10_000;

function resolveTimeoutMs(): number {
  const raw = process.env.MCP_OAUTH_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULT_MCP_OAUTH_FETCH_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MCP_OAUTH_FETCH_TIMEOUT_MS;
}

/**
 * Builds the signal for a request: always the per-request timeout, combined
 * with any caller-supplied signal so an upstream abort still wins. `fetchImpl`
 * is injectable purely so tests can supply a fake slow/erroring server.
 */
export function createSafeFetch(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = resolveTimeoutMs(),
): FetchLike {
  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // Combine the caller's signal (if any) with our timeout so either can abort.
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

    let resp: Response;
    try {
      resp = await fetchImpl(input, { ...init, cache: "no-store", signal });
    } catch (err) {
      // A timeout surfaces as an AbortError; make it observable and give the
      // SDK a distinct, non-opaque failure to classify rather than a bare
      // network reject. The route handlers translate this into a clean
      // ?mcp=error redirect (never a 502).
      const timedOut =
        timeoutSignal.aborted ||
        (err instanceof Error && err.name === "TimeoutError");
      logger.warn(
        {
          url: typeof input === "string" ? input : String(input),
          timeoutMs,
          timedOut,
          err: String(err),
        },
        timedOut
          ? "mcp-oauth: safeFetch timed out talking to authorization server"
          : "mcp-oauth: safeFetch network error talking to authorization server",
      );
      throw err;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return new Response(text || null, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    }
    return resp;
  };
}

/** Shared, timeout-bounded fetch used by both MCP OAuth route handlers. */
export const safeFetch: FetchLike = createSafeFetch();
