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
 * `x-forwarded-for` is the fallback, and it is read two ways, identity first.
 *
 *  - By proxy IDENTITY, when `trustedProxyCidrs` names the proxies in front of
 *    this deployment. Each proxy APPENDS the address it received the request
 *    from, so the header reads oldest-first and everything a caller sent sits
 *    on the left. The walk goes right while each entry is one of the named
 *    proxies and stops at the first that is not: the furthest address a trusted
 *    proxy vouched for, which is the client. An entry counts only if a trusted
 *    proxy WROTE it, meaning at least one trusted entry stood to its right —
 *    otherwise a request that never passed through a named proxy (a typo in the
 *    list, a network change, a path that bypasses it) would have its
 *    caller-supplied header believed whole.
 *  - By hop COUNT, when no proxies are named, for the IAM allowlist as a
 *    documented legacy fallback. With N trusted proxies the client's own
 *    address is the Nth entry from the right. This form is weaker and is why
 *    the identity walk exists: a count trusts ITSELF to be right, and one that
 *    is too high lets a caller pad the header until the arithmetic lands on a
 *    value the caller chose. Nothing readable from the request separates that
 *    from a correct deeper chain. A chain SHORTER than the declared count is
 *    refused outright rather than clamped to the leftmost entry: the leftmost
 *    entry is the oldest thing ANYONE could have written, so clamping turned a
 *    misconfigured count into the exact bypass the walk exists to prevent.
 *
 * Where both forms are configured, identity wins — it is the only one that can
 * defend itself. The pre-authentication rate-limit ceilings therefore pass
 * `trustedProxyHops: 0` and accept only an edge header or the identity walk.
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
   * deployment trusts. 0 means nothing in front of this process rewrote the
   * header, so no entry in it is usable — which is also what a caller that
   * wants only the identity walk passes.
   *
   * Consulted ONLY when `trustedProxyCidrs` is empty. Prefer naming the
   * proxies: a count cannot tell an over-declared depth from a real one.
   */
  trustedProxyHops: number;
  /**
   * The proxies in front of this deployment, by identity — CIDRs or bare
   * addresses. When non-empty this is the derivation used, and the hop count is
   * not consulted at all. Empty by default.
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
    trustedProxyHops,
    trustedProxyCidrs = [],
    trustEdgeHeader = false,
    onVercel = false,
  }: TrustedClientIpOptions,
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

  // Preferred: attribute by proxy IDENTITY. Padding the left of the header only
  // lengthens a prefix this walk never reaches, because stopping is decided by
  // what an entry IS rather than by how many entries there are.
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

  if (trustedProxyHops > 0 && chain.length > 0) {
    // A chain shorter than the declared depth means a proxy did not append what
    // this deployment says it does, so NOTHING here is attributable. This used
    // to clamp the index to 0 and return the leftmost entry as "the oldest
    // thing any trusted proxy could have written". That reasoning is wrong: the
    // leftmost entry is the oldest thing ANYONE could have written, and a caller
    // writes it by sending its own x-forwarded-for. Refuse instead — a
    // correctly declared depth never produces a short chain, so this only fires
    // where the count is wrong, and failing closed is the documented direction
    // for that case.
    if (chain.length < trustedProxyHops) return null;
    return sanitizeClientIp(chain[chain.length - trustedProxyHops]);
  }

  return null;
}
