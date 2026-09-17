// client-ip.test.ts
//
// The derivation every surface makes an IAM ip_ranges decision through. The
// cases that matter are the spoof shapes: a caller who writes x-forwarded-for,
// x-real-ip, or the edge header itself must not be able to name the address
// this returns.

import { describe, expect, it } from "vitest";
import {
  EDGE_CLIENT_IP_HEADER,
  extractTrustedClientIp,
  sanitizeClientIp,
} from "./client-ip";

/** Reads from a plain header bag, the way every caller's adapter does. */
function reader(headers: Record<string, string>) {
  return (name: string): string | undefined => headers[name.toLowerCase()];
}

describe("extractTrustedClientIp", () => {
  const PROXIES = ["10.0.0.0/8"];

  it("prefers the edge header and ignores everything a caller can write", () => {
    expect(
      extractTrustedClientIp(
        reader({
          [EDGE_CLIENT_IP_HEADER]: "198.51.100.1",
          "x-forwarded-for": "203.0.113.9, 10.0.0.5",
          "x-real-ip": "203.0.113.8",
        }),
        { trustedProxyCidrs: PROXIES, trustEdgeHeader: true },
      ),
    ).toBe("198.51.100.1");
  });

  // The #3183 second P1. The edge header is trustworthy only because Caddy SETS
  // it, and Caddy's config deploys through a different pipeline than this code.
  // In the skew window the old Caddyfile has no rule for that header name and
  // forwards a caller-supplied copy straight through.
  //
  // What this case has to discriminate: an implementation that reads the header
  // whenever it is present passes a test asserting "the header is preferred".
  // So the header here carries an address a caller would want an IAM ip_ranges
  // allowlist to match, the flag is off, and the assertion is that the value
  // does not come back — not merely that some other value is preferred.
  it("does not believe a forged edge header while the gate is off", () => {
    const forged = "198.51.100.1";
    expect(
      extractTrustedClientIp(reader({ [EDGE_CLIENT_IP_HEADER]: forged }), {
        trustedProxyCidrs: PROXIES,
      }),
    ).toBeNull();

    // With a vouched-for chain present the caller does not get to jump the
    // queue either: the identity walk answers, and it lands on what the named
    // proxy wrote rather than on the header the caller chose.
    expect(
      extractTrustedClientIp(
        reader({
          [EDGE_CLIENT_IP_HEADER]: forged,
          "x-forwarded-for": "203.0.113.9, 10.0.0.5",
        }),
        { trustedProxyCidrs: PROXIES },
      ),
    ).toBe("203.0.113.9");

    // Same request, gate on: this is what the operator opts into once the edge
    // is actually replacing the header.
    expect(
      extractTrustedClientIp(reader({ [EDGE_CLIENT_IP_HEADER]: forged }), {
        trustedProxyCidrs: PROXIES,
        trustEdgeHeader: true,
      }),
    ).toBe(forged);
  });

  // Omitting the option must be the safe state, not an unset one.
  it("defaults the edge-header gate to off", () => {
    expect(
      extractTrustedClientIp(
        reader({ [EDGE_CLIENT_IP_HEADER]: "198.51.100.1" }),
        {},
      ),
    ).toBeNull();
  });

  // The post-rewrite shape. Caddy SETS x-forwarded-for to the single client
  // address, so no proxy entry remains for the identity walk to vouch with and
  // the edge header is the only thing left that can name the caller. This is
  // why TRUSTED_PROXY_CIDRS must not be set in that shape — ADR-083.
  it("attributes by edge header alone once the chain has been rewritten", () => {
    expect(
      extractTrustedClientIp(
        reader({
          [EDGE_CLIENT_IP_HEADER]: "198.51.100.1",
          "x-forwarded-for": "198.51.100.1",
        }),
        { trustEdgeHeader: true },
      ),
    ).toBe("198.51.100.1");
    // And with the list set, the walk finds nothing to vouch for the entry —
    // the failure mode the ADR warns an operator away from.
    expect(
      extractTrustedClientIp(reader({ "x-forwarded-for": "198.51.100.1" }), {
        trustedProxyCidrs: PROXIES,
      }),
    ).toBeNull();
  });

  // Nothing in either deployment shape sets x-real-ip, so a value under that
  // name came from the caller — and the only moment the old code read it was
  // when no trusted proxy had written a forwarded chain.
  it("never consults x-real-ip", () => {
    expect(
      extractTrustedClientIp(reader({ "x-real-ip": "198.51.100.1" }), {
        trustedProxyCidrs: PROXIES,
      }),
    ).toBeNull();
  });

  // #3205 deleted the hop-count fallback rather than deprecating it. A caller
  // controls the header's LENGTH, so any count too high by k lets it pad k
  // entries until the arithmetic lands on a value it chose, and nothing in the
  // request tells that apart from a correct deeper chain.
  it("derives nothing at all when no proxies are named", () => {
    // A chain that a hop count would happily have read an address out of.
    expect(
      extractTrustedClientIp(
        reader({ "x-forwarded-for": "203.0.113.9, 198.51.100.1, 172.31.0.4" }),
        {},
      ),
    ).toBeNull();
    expect(extractTrustedClientIp(reader({}), {})).toBeNull();
  });

  describe("attribution by proxy identity", () => {
    // A hop count trusts the COUNT. One that is too high lets a caller pad
    // x-forwarded-for until the arithmetic lands on a value the caller chose,
    // and nothing readable from the request separates that from a correct
    // deeper chain. Naming the proxies removes the arithmetic: the walk stops
    // on what an entry IS.
    const cidrs = ["10.0.0.0/8"];

    it("stops at the first entry that is not a trusted proxy", () => {
      expect(
        extractTrustedClientIp(
          reader({ "x-forwarded-for": "203.0.113.7, 10.0.0.5" }),
          { trustedProxyCidrs: cidrs },
        ),
      ).toBe("203.0.113.7");
    });

    it("is unmoved by a caller padding the header", () => {
      // Under a hop count the prepended entries are the bypass; here the walk
      // never reaches them.
      expect(
        extractTrustedClientIp(
          reader({
            "x-forwarded-for": "198.51.100.1, 10.1.1.1, 203.0.113.7, 10.0.0.5",
          }),
          { trustedProxyCidrs: cidrs },
        ),
      ).toBe("203.0.113.7");
    });

    it("refuses a chain no trusted proxy vouched for", () => {
      // An entry is attributable only if a TRUSTED PROXY WROTE IT, meaning at
      // least one trusted entry stood to its right. Both shapes: a lone
      // untrusted entry, and a trusted proxy sitting to the LEFT of an
      // untrusted one, which is the ordering that looks configured and is not.
      expect(
        extractTrustedClientIp(reader({ "x-forwarded-for": "203.0.113.7" }), {
          trustedProxyCidrs: cidrs,
        }),
      ).toBeNull();
      expect(
        extractTrustedClientIp(
          reader({ "x-forwarded-for": "10.0.0.5, 203.0.113.7" }),
          { trustedProxyCidrs: cidrs },
        ),
      ).toBeNull();
    });

    it("refuses when every entry is a trusted proxy", () => {
      // None of them is a client — better than returning a proxy and calling
      // it a caller.
      expect(
        extractTrustedClientIp(
          reader({ "x-forwarded-for": "10.0.0.4, 10.0.0.5" }),
          { trustedProxyCidrs: cidrs },
        ),
      ).toBeNull();
      expect(
        extractTrustedClientIp(reader({}), {
          trustedProxyCidrs: cidrs,
        }),
      ).toBeNull();
    });

    it("takes precedence over the hop count when both are set", () => {
      // The count alone would pick the rightmost entry, i.e. the proxy itself.
      expect(
        extractTrustedClientIp(
          reader({ "x-forwarded-for": "203.0.113.7, 10.0.0.5" }),
          { trustedProxyCidrs: cidrs },
        ),
      ).toBe("203.0.113.7");
    });

    it("yields to the edge header, which the deployment wrote itself", () => {
      expect(
        extractTrustedClientIp(
          reader({
            [EDGE_CLIENT_IP_HEADER]: "198.51.100.1",
            "x-forwarded-for": "203.0.113.7, 10.0.0.5",
          }),
          { trustedProxyCidrs: cidrs, trustEdgeHeader: true },
        ),
      ).toBe("198.51.100.1");
    });

    it("bounds what the walk returns, like every other path", () => {
      expect(
        extractTrustedClientIp(
          reader({ "x-forwarded-for": "not-an-ip, 10.0.0.5" }),
          { trustedProxyCidrs: cidrs },
        ),
      ).toBeNull();
    });
  });

  it("trusts only Vercel's own header when running on Vercel", () => {
    const headers = reader({
      "x-vercel-forwarded-for": "198.51.100.1, 10.0.0.1",
      [EDGE_CLIENT_IP_HEADER]: "203.0.113.9",
      "x-forwarded-for": "203.0.113.8",
    });
    // There is no Caddy in front of a Vercel deployment, so an edge header
    // arriving there came from the caller.
    expect(
      extractTrustedClientIp(headers, {
        trustedProxyCidrs: ["10.0.0.0/8"],
        trustEdgeHeader: true,
        onVercel: true,
      }),
    ).toBe("198.51.100.1");
    expect(
      extractTrustedClientIp(
        reader({ [EDGE_CLIENT_IP_HEADER]: "203.0.113.9" }),
        {
          trustedProxyCidrs: ["10.0.0.0/8"],
          trustEdgeHeader: true,
          onVercel: true,
        },
      ),
    ).toBeNull();
  });

  it("rejects anything that is not an address literal", () => {
    for (const value of [
      "not-an-ip",
      "198.51.100.1 198.51.100.2",
      " ",
      "f".repeat(46),
      "198.51.100.1; DROP",
    ]) {
      expect(
        extractTrustedClientIp(reader({ [EDGE_CLIENT_IP_HEADER]: value }), {
          trustEdgeHeader: true,
        }),
      ).toBeNull();
    }
  });

  it("carries IPv4 and IPv6 through unchanged", () => {
    for (const value of ["198.51.100.1", "2001:db8::1", "::ffff:192.0.2.128"]) {
      expect(sanitizeClientIp(value)).toBe(value);
    }
  });
});
