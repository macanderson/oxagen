import { requireEnv } from "@oxagen/config/env";
import { extractTrustedClientIp } from "@oxagen/oxagen/client-ip";

/**
 * How many proxies sit between the client and this process, resolved from the
 * validated env once and memoized. Wrapped in a function (called at first
 * request, not module load) so importing a route never triggers env access —
 * mirroring `trustedProxyHops()` in apps/api/src/lib/context.ts.
 */
let cachedTrustedProxyHops: number | null = null;
function trustedProxyHops(): number {
  if (cachedTrustedProxyHops !== null) return cachedTrustedProxyHops;
  cachedTrustedProxyHops = requireEnv([
    "TRUSTED_PROXY_HOP_COUNT",
  ] as const).TRUSTED_PROXY_HOP_COUNT;
  return cachedTrustedProxyHops;
}

/**
 * Whether the edge-written `x-oxagen-client-ip` header is believed, resolved
 * from the validated env once and memoized alongside the hop count. Off by
 * default: the header is only trustworthy once the Caddy config that SETS it is
 * deployed, and that ships through a different pipeline than this code. See
 * packages/oxagen/src/client-ip.ts.
 */
let cachedTrustEdgeHeader: boolean | null = null;
function trustEdgeHeader(): boolean {
  if (cachedTrustEdgeHeader !== null) return cachedTrustEdgeHeader;
  cachedTrustEdgeHeader = requireEnv([
    "TRUST_EDGE_CLIENT_IP_HEADER",
  ] as const).TRUST_EDGE_CLIENT_IP_HEADER;
  return cachedTrustEdgeHeader;
}

/**
 * The client address this deployment is willing to make a decision on, read
 * from a Next.js request through the one shared derivation
 * (`@oxagen/oxagen/client-ip`, which carries the reasoning about which headers
 * are believed where).
 *
 * Every route in apps/app that needs a client address calls this. Reaching for
 * `request.headers.get("x-forwarded-for")` directly is the bug this exists to
 * prevent: behind the ALB the leftmost entry of that header is caller-written,
 * and it was deciding IAM `ip_ranges` outcomes.
 */
export function requestClientIp(request: {
  headers: { get: (name: string) => string | null };
}): string | null {
  return extractTrustedClientIp((name) => request.headers.get(name), {
    trustedProxyHops: trustedProxyHops(),
    trustedProxyCidrs: trustedProxyCidrs(),
    trustEdgeHeader: trustEdgeHeader(),
    onVercel: process.env.VERCEL === "1",
  });
}

/**
 * The proxies this deployment trusts, by identity rather than by count.
 * Memoized on the same terms as the hop count above, and preferred over it:
 * a count cannot tell an over-declared depth from a real one.
 */
let cachedTrustedProxyCidrs: string[] | null = null;
function trustedProxyCidrs(): string[] {
  if (cachedTrustedProxyCidrs !== null) return cachedTrustedProxyCidrs;
  cachedTrustedProxyCidrs = requireEnv(["TRUSTED_PROXY_CIDRS"] as const)
    .TRUSTED_PROXY_CIDRS.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return cachedTrustedProxyCidrs;
}

/** Test seam: drop the memoized hop count so a case can set a different env. */
export function __resetTrustedProxyHopsForTests(): void {
  cachedTrustedProxyHops = null;
  cachedTrustEdgeHeader = null;
  cachedTrustedProxyCidrs = null;
}
