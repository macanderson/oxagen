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
    onVercel: process.env.VERCEL === "1",
  });
}

/** Test seam: drop the memoized hop count so a case can set a different env. */
export function __resetTrustedProxyHopsForTests(): void {
  cachedTrustedProxyHops = null;
}
