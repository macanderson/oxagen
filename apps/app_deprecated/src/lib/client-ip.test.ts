// The apps/app seam onto the shared client-IP derivation. The derivation's own
// cases live in packages/oxagen/src/client-ip.test.ts; what matters here is
// that this surface reads through it at all, because it did not.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTrustedProxyHopsForTests, requestClientIp } from "./client-ip";

function request(headers: Record<string, string>): {
  headers: { get: (name: string) => string | null };
} {
  return { headers: { get: (name) => headers[name.toLowerCase()] ?? null } };
}

beforeEach(() => {
  __resetTrustedProxyHopsForTests();
  vi.stubEnv("TRUSTED_PROXY_HOP_COUNT", "2");
});

afterEach(() => {
  __resetTrustedProxyHopsForTests();
  vi.unstubAllEnvs();
});

describe("requestClientIp", () => {
  it("prefers the address the edge wrote", () => {
    // Only once the operator has turned the gate on, after the Caddy config
    // that SETS the header is deployed (ADR-083).
    __resetTrustedProxyHopsForTests();
    vi.stubEnv("TRUST_EDGE_CLIENT_IP_HEADER", "true");
    expect(
      requestClientIp(
        request({
          "x-oxagen-client-ip": "198.51.100.1",
          "x-forwarded-for": "203.0.113.9, 192.0.2.5",
        }),
      ),
    ).toBe("198.51.100.1");
  });

  // The #3183 second P1. Until the Caddy config lands, the old Caddyfile has no
  // rule for x-oxagen-client-ip and forwards a caller's copy unchanged, and
  // this value reaches the IAM ip_ranges condition on the chat stream route.
  //
  // Forged header, gate off, and the assertion is that the forged value does
  // not come back — "the edge header wins when present" would pass against the
  // implementation being flagged.
  it("does not believe a forged edge header before the gate is turned on", () => {
    expect(
      requestClientIp(request({ "x-oxagen-client-ip": "198.51.100.1" })),
    ).toBeNull();

    expect(
      requestClientIp(
        request({
          "x-oxagen-client-ip": "198.51.100.1",
          "x-forwarded-for": "203.0.113.9, 192.0.2.5",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  // #3183 P1. This value reaches the IAM ip_ranges condition on the chat
  // stream route, which ALLOWS on a CIDR match; the route took the leftmost
  // x-forwarded-for entry, which behind the ALB the caller writes.
  it("ignores a caller-supplied x-forwarded-for prefix", () => {
    expect(
      requestClientIp(
        request({ "x-forwarded-for": "203.0.113.9, 198.51.100.1, 172.31.0.4" }),
      ),
    ).toBe("198.51.100.1");
  });

  it("never believes x-real-ip", () => {
    expect(
      requestClientIp(request({ "x-real-ip": "198.51.100.1" })),
    ).toBeNull();
  });

  it("returns null when no trusted proxy named the caller", () => {
    expect(requestClientIp(request({}))).toBeNull();
  });
});
