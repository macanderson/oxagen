/**
 * return-to.test.ts — unit tests for the MCP OAuth returnTo open-redirect guard.
 *
 * `resolveReturnTo` accepts a caller-supplied post-OAuth landing path that
 * round-trips through the OAuth state store into a NextResponse.redirect, so
 * it must only ever admit same-origin paths inside the caller's own org.
 *
 * Covers:
 *   - null / undefined / empty → fallback (the MCP Servers page)
 *   - valid same-org paths pass through unchanged (incl. query strings)
 *   - `/{orgSlug}` exact is allowed
 *   - rejects: relative paths (no leading slash), scheme-relative `//evil.com`,
 *     absolute URLs, backslash tricks, embedded scheme separators, CR/LF
 *     header-injection, and other-org / prefix-spoofed paths
 *   - defaultMcpReturnTo shape
 */

import { describe, it, expect } from "vitest";
import { resolveReturnTo, defaultMcpReturnTo } from "./return-to";

const ORG = "acme";
const WS = "main";
const FALLBACK = "/acme/main/studio/tools/mcp";

describe("defaultMcpReturnTo", () => {
  it("points at Studio → Agent Tools → MCP Servers for the given scope", () => {
    expect(defaultMcpReturnTo(ORG, WS)).toBe(FALLBACK);
    expect(defaultMcpReturnTo("other", "ws2")).toBe("/other/ws2/studio/tools/mcp");
  });
});

describe("resolveReturnTo — fallback on missing input", () => {
  it("returns the fallback for null", () => {
    expect(resolveReturnTo(null, ORG, WS)).toBe(FALLBACK);
  });

  it("returns the fallback for undefined", () => {
    expect(resolveReturnTo(undefined, ORG, WS)).toBe(FALLBACK);
  });

  it("returns the fallback for the empty string", () => {
    expect(resolveReturnTo("", ORG, WS)).toBe(FALLBACK);
  });
});

describe("resolveReturnTo — valid same-org paths pass through", () => {
  it("passes a same-org path through unchanged", () => {
    expect(resolveReturnTo("/acme/main/marketplace/agent-tools", ORG, WS)).toBe(
      "/acme/main/marketplace/agent-tools",
    );
  });

  it("preserves a query string on a same-org path", () => {
    expect(
      resolveReturnTo("/acme/main/studio/tools/mcp?tab=installed&x=1", ORG, WS),
    ).toBe("/acme/main/studio/tools/mcp?tab=installed&x=1");
  });

  it("allows the bare /{orgSlug} path exactly", () => {
    expect(resolveReturnTo("/acme", ORG, WS)).toBe("/acme");
  });

  it("allows /{orgSlug}/ and deeper paths", () => {
    expect(resolveReturnTo("/acme/", ORG, WS)).toBe("/acme/");
    expect(resolveReturnTo("/acme/billing", ORG, WS)).toBe("/acme/billing");
  });
});

describe("resolveReturnTo — open-redirect vectors are rejected", () => {
  it("rejects a path without a leading slash", () => {
    expect(resolveReturnTo("acme/main/x", ORG, WS)).toBe(FALLBACK);
  });

  it("rejects scheme-relative //evil.com (protocol-relative redirect)", () => {
    expect(resolveReturnTo("//evil.com", ORG, WS)).toBe(FALLBACK);
    expect(resolveReturnTo("//evil.com/acme/main", ORG, WS)).toBe(FALLBACK);
  });

  it("rejects absolute URLs", () => {
    expect(resolveReturnTo("https://evil.com", ORG, WS)).toBe(FALLBACK);
    expect(resolveReturnTo("https://evil.com/acme/main", ORG, WS)).toBe(FALLBACK);
    expect(resolveReturnTo("http://evil.com/", ORG, WS)).toBe(FALLBACK);
  });

  it("rejects backslash tricks (browsers normalise \\ to /)", () => {
    expect(resolveReturnTo("/acme\\evil.com", ORG, WS)).toBe(FALLBACK);
    expect(resolveReturnTo("/\\evil.com", ORG, WS)).toBe(FALLBACK);
    expect(resolveReturnTo("\\\\evil.com", ORG, WS)).toBe(FALLBACK);
  });

  it("rejects an embedded scheme separator inside a same-org path", () => {
    expect(resolveReturnTo("/acme/https://evil.com", ORG, WS)).toBe(FALLBACK);
  });

  it("rejects CR/LF header-injection payloads", () => {
    expect(
      resolveReturnTo("/acme/x\r\nSet-Cookie: session=stolen", ORG, WS),
    ).toBe(FALLBACK);
    expect(resolveReturnTo("/acme/x\rY", ORG, WS)).toBe(FALLBACK);
    expect(resolveReturnTo("/acme/x\nY", ORG, WS)).toBe(FALLBACK);
  });

  it("rejects a path in another org's URL space", () => {
    expect(resolveReturnTo("/other-org/x", ORG, WS)).toBe(FALLBACK);
  });

  it("rejects an org-slug prefix spoof (/acmeevil is not /acme)", () => {
    expect(resolveReturnTo("/acmeevil", ORG, WS)).toBe(FALLBACK);
    expect(resolveReturnTo("/acme-evil/x", ORG, WS)).toBe(FALLBACK);
  });
});
