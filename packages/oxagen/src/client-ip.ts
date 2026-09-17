/**
 * The one client-IP derivation in the repo.
 *
 * Every surface that hands a client address to an authorization decision reads
 * it through here. That is not tidiness: the address feeds the IAM `ip_ranges`
 * / `ip_allow` conditions (`iam/conditions.ts`), which ALLOW on a CIDR match,
 * so whoever controls the value controls whether an IP-scoped mandate applies.
 * Three surfaces each grew their own version of this and each of the three
 * took the leftmost `x-forwarded-for` entry, which is the one value in the
 * request a caller can write freely.
 *
 * Two headers are trusted, and only in the deployment shape that writes them:
 *
 *  - `x-oxagen-client-ip` on AWS. Caddy sets it with `header_up`, which
 *    REPLACES the field, so a copy the caller sent under the same name never
 *    reaches the process. See `infra/tools/caddy/Caddyfile.alb`.
 *  - `x-vercel-forwarded-for` on Vercel, which Vercel replaces at its own
 *    boundary. Not consulted off Vercel: there is no Caddy in front of a Vercel
 *    deployment and no Vercel edge in front of an AWS one, so each header is
 *    believable in exactly one place.
 *
 * `x-forwarded-for` is the fallback, walked from the RIGHT. Each proxy APPENDS
 * the address it received the request from, so the header reads oldest-first
 * and everything a caller sent sits on the left. With N trusted proxies the
 * client's own address is the Nth entry from the right — those are the N
 * entries our own proxies wrote. A caller who prepends hops only lengthens the
 * untrusted left-hand side and cannot move the entry this picks.
 *
 * `x-real-ip` is NOT consulted, and its absence is the point. Nothing in either
 * deployment shape sets it: not the ALB, not Caddy, not Vercel. A value
 * arriving under that name therefore came from the caller, and the only moment
 * the old code reached for it was when no trusted proxy had written
 * `x-forwarded-for` — precisely the moment nothing had vouched for the request.
 * Reading it was a way to turn "I do not know who this is" into an allowlist
 * match.
 *
 * Returning `null` is safe and deliberate. `ipInRanges` treats a null client IP
 * as no match, so an IP-scoped condition DENIES rather than allows. An IP
 * allowlist that stops matching is visible; one that matches the wrong client
 * is not.
 */

/** Set by Caddy from `{client_ip}`; see the Caddyfile note this name appears in. */
export const EDGE_CLIENT_IP_HEADER = "x-oxagen-client-ip";

/** Replaced by Vercel's edge, and believable only there. */
export const VERCEL_CLIENT_IP_HEADER = "x-vercel-forwarded-for";

/**
 * Longest address literal accepted. 45 characters is an IPv4-mapped IPv6
 * address (`0000:...:ffff:255.255.255.255`), the longest textual form there is.
 */
export const MAX_CLIENT_IP_LENGTH = 45;

/** The characters an IPv4 or IPv6 literal is made of, and nothing else. */
const IP_LITERAL_PATTERN = /^[0-9a-fA-F.:]+$/;

/**
 * Bound what a header can become downstream. A trusted proxy should never send
 * anything but a single address, so this guards against the proxy being
 * misconfigured rather than against the caller: an unbounded or structured
 * value would otherwise reach a CIDR matcher, a log line and a Postgres bucket
 * key as-is.
 */
export function sanitizeClientIp(
  raw: string | null | undefined,
): string | null {
  const value = raw?.trim();
  if (!value || value.length > MAX_CLIENT_IP_LENGTH) return null;
  return IP_LITERAL_PATTERN.test(value) ? value : null;
}

/** Reads one request header by lowercase name; `null`/`undefined` when absent. */
export type HeaderReader = (name: string) => string | null | undefined;

export interface TrustedClientIpOptions {
  /**
   * How many right-hand `x-forwarded-for` entries were written by proxies this
   * deployment trusts — 2 for the deployed ALB → Caddy shape, because the ALB
   * appends the client and Caddy appends the ALB. 0 means nothing in front of
   * this process rewrote the header, so no entry in it is usable.
   */
  trustedProxyHops: number;
  /** True only when running on Vercel. */
  onVercel?: boolean;
}

/**
 * The client address this deployment is willing to make an authorization
 * decision on, or `null` when nothing trustworthy said who the caller is.
 */
export function extractTrustedClientIp(
  getHeader: HeaderReader,
  { trustedProxyHops, onVercel = false }: TrustedClientIpOptions,
): string | null {
  if (onVercel) {
    return sanitizeClientIp(
      getHeader(VERCEL_CLIENT_IP_HEADER)?.split(",", 1)[0],
    );
  }

  const edge = sanitizeClientIp(getHeader(EDGE_CLIENT_IP_HEADER));
  if (edge) return edge;

  if (trustedProxyHops > 0) {
    const chain = (getHeader("x-forwarded-for") ?? "")
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    if (chain.length > 0) {
      // A chain shorter than the trusted-proxy count means a proxy did not
      // append what this deployment says it does. Clamping to 0 then yields the
      // oldest entry any trusted proxy could have written, which is the most
      // conservative reading available — never an entry further right, which
      // would be one of our own proxies' addresses.
      return sanitizeClientIp(
        chain[Math.max(0, chain.length - trustedProxyHops)],
      );
    }
  }

  return null;
}
