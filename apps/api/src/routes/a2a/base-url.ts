import type { Context } from "hono";
import type { AppEnv } from "../../app";

/**
 * Resolve the public base URL (scheme + host, no trailing slash) the client
 * reached us on, honoring reverse-proxy forwarding headers. Used to build the
 * A2A Agent Card's service endpoint and the well-known card URL so they always
 * point at the host the request actually arrived on.
 */
export function requestBaseUrl(c: Context<AppEnv>): string {
  const forwardedProto = c.req.header("x-forwarded-proto");
  const forwardedHost = c.req.header("x-forwarded-host");
  const host = forwardedHost ?? c.req.header("host");
  if (host) {
    const proto = forwardedProto ?? "https";
    return `${proto}://${host}`;
  }
  // Fall back to parsing the request URL (dev / direct connections).
  try {
    const u = new URL(c.req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "https://api.oxagen.sh";
  }
}
