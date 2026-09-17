import { ipInRanges } from "./iam/conditions";

/**
 * The one client-IP derivation in the repo (ADR-083).
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
 *  - `x-oxagen-client-ip` on AWS, and only when `trustEdgeHeader` is true.
 *    Caddy sets it with `header_up`, which REPLACES the field, so a copy the
 *    caller sent under the same name never reaches the process. See
 *    `infra/tools/caddy/Caddyfile.alb`. The flag exists because that Caddy
 *    config ships through the infra pipeline and this code ships through the
 *    application one: in the window where the code has deployed and the config
 *    has not, the OLD Caddyfile has no rule for this header name and forwards a
 *    caller-supplied copy unchanged. Trusting it unconditionally would hand an
 *    attacker a by-name route into an IAM `ip_ranges` decision and into
 *    pre-authentication rate-limit bucket keys — strictly worse than the
 *    leftmost-`x-forwarded-for` defect this file was written to close, because
 *    that one at least required guessing the topology. Defaulting the flag off
 *    puts the safe state on the default path and makes enabling the header a
 *    deliberate act the operator performs after the edge is in place.
 *  - `x-vercel-forwarded-for` on Vercel, which Vercel replaces at its own
 *    boundary. Not consulted off Vercel: there is no Caddy in front of a Vercel
 *    deployment and no Vercel edge in front of an AWS one, so each header is
 *    believable in exactly one place.
 *
 * `x-forwarded-for` is the fallback, and it is read by proxy IDENTITY alone.
 * Each proxy APPENDS the address it received the request from, so the header
 * reads oldest-first and everything a caller sent sits on the left. The walk
 * goes right while each entry is one of the proxies named in
 * `trustedProxyCidrs` and stops at the first that is not: the furthest address
 * a trusted proxy vouched for, which is the client. An entry counts only if a
 * trusted proxy WROTE it, meaning at least one trusted entry stood to its
 * right — otherwise a request that never passed through a named proxy (a typo
 * in the list, a network change, a path that bypasses it) would have its
 * caller-supplied header believed whole.
 *
 * There is no hop-COUNT fallback, and its absence is deliberate (#3205). A
 * count trusts ITSELF to be right; a caller controls the header's LENGTH, so a
 * count too high by k lets it pad k entries until the arithmetic lands on a
 * value it chose, and nothing readable from the request tells that apart from a
 * correct deeper chain. `TRUSTED_PROXY_HOP_COUNT` is retired from the schema
 * rather than deprecated, because a fallback that silently produces an
 * unvouched-for address is worse than no address: it turns "this deployment
 * cannot attribute callers" into "this allowlist is enforced", which is a lie
 * an operator acts on.
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
   * The proxies in front of this deployment, by identity — CIDRs or bare
   * addresses. Empty (the default) means this deployment has declared nothing,
   * so no `x-forwarded-for` entry is attributable and the result is `null`.
   */
  trustedProxyCidrs?: string[];
  /**
   * Whether `x-oxagen-client-ip` is believed. Defaults to FALSE: the header is
   * only trustworthy once the edge that SETS it is deployed, and that deploy is
   * a separate manual pipeline. See the note on that header above.
   */
  trustEdgeHeader?: boolean;
  /** True only when running on Vercel. */
  onVercel?: boolean;
}

/**
 * The client address this deployment is willing to make an authorization
 * decision on, or `null` when nothing trustworthy said who the caller is.
 */
export function extractTrustedClientIp(
  getHeader: HeaderReader,
  {
    trustedProxyCidrs = [],
    trustEdgeHeader = false,
    onVercel = false,
  }: TrustedClientIpOptions = {},
): string | null {
  if (onVercel) {
    return sanitizeClientIp(
      getHeader(VERCEL_CLIENT_IP_HEADER)?.split(",", 1)[0],
    );
  }

  // Not read at all when the flag is off — not read-and-discarded. A forged
  // `x-oxagen-client-ip` must not reach a decision, and the branch that would
  // take it runs before the fallback.
  if (trustEdgeHeader) {
    const edge = sanitizeClientIp(getHeader(EDGE_CLIENT_IP_HEADER));
    if (edge) return edge;
  }

  const chain = (getHeader("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);

  // Attribute by proxy IDENTITY, the only form of this walk there is. Padding
  // the left of the header only lengthens a prefix the walk never reaches,
  // because stopping is decided by what an entry IS rather than by how many
  // entries there are.
  if (trustedProxyCidrs.length > 0) {
    if (chain.length === 0) return null;
    let vouchedFor = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i] as string;
      if (ipInRanges(entry, trustedProxyCidrs)) {
        vouchedFor = true;
        continue;
      }
      // Attributable only if a TRUSTED PROXY WROTE IT — i.e. at least one
      // trusted entry stood to its right. Without that, the rightmost entry is
      // whatever the caller sent, which is what a request that never passed
      // through a named proxy looks like.
      return vouchedFor ? sanitizeClientIp(entry) : null;
    }
    // Every entry is a trusted proxy, so none of them is a client. Nothing to
    // attribute — better than returning a proxy and calling it a caller.
    return null;
  }

  // Nothing named a proxy, so nothing in `x-forwarded-for` is attributable and
  // there is no weaker reading to fall back to. `null` denies an IP condition
  // and skips a pre-authentication ceiling, both of which are honest about the
  // deployment not being able to name its callers.
  return null;
}
