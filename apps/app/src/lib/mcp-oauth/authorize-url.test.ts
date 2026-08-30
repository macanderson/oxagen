/**
 * authorize-url.test.ts — unit tests for mcpAuthorizeUrl.
 *
 * The builder produces the app-relative GET /api/v1/mcp/oauth/authorize URL
 * that the Authenticate buttons/dialog navigate the whole window to.
 *
 * Covers:
 *   - all required params are present in the query string
 *   - returnTo is optional (absent when not provided, included when it is)
 *   - slugs/ids with URL-significant characters are percent-encoded and
 *     round-trip losslessly through URLSearchParams
 */

import { describe, it, expect } from "vitest";
import { mcpAuthorizeUrl } from "./authorize-url";

function paramsOf(url: string): URLSearchParams {
  const [, query = ""] = url.split("?");
  return new URLSearchParams(query);
}

describe("mcpAuthorizeUrl", () => {
  it("targets the authorize route and carries orgSlug, workspaceSlug, orgListingId", () => {
    const url = mcpAuthorizeUrl({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "listing-1",
    });

    expect(url.startsWith("/api/v1/mcp/oauth/authorize?")).toBe(true);
    const params = paramsOf(url);
    expect(params.get("orgSlug")).toBe("acme");
    expect(params.get("workspaceSlug")).toBe("main");
    expect(params.get("orgListingId")).toBe("listing-1");
  });

  it("omits returnTo when not provided", () => {
    const url = mcpAuthorizeUrl({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "listing-1",
    });

    expect(paramsOf(url).has("returnTo")).toBe(false);
    expect(url).not.toContain("returnTo");
  });

  it("includes returnTo when provided", () => {
    const url = mcpAuthorizeUrl({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: "listing-1",
      returnTo: "/acme/main/workbench/tools/mcp",
    });

    expect(paramsOf(url).get("returnTo")).toBe(
      "/acme/main/workbench/tools/mcp",
    );
  });

  it("percent-encodes URL-significant characters so values round-trip losslessly", () => {
    const url = mcpAuthorizeUrl({
      orgSlug: "org/with slash",
      workspaceSlug: "ws&amp=x",
      orgListingId: "id?query=1",
      returnTo: "/org/with slash/page?tab=a&b=2",
    });

    // Raw separators from values never leak into the query structure.
    expect(url).toContain("orgSlug=org%2Fwith+slash");
    expect(url.indexOf("?")).toBe(url.lastIndexOf("?"));

    // And every value survives the round-trip exactly.
    const params = paramsOf(url);
    expect(params.get("orgSlug")).toBe("org/with slash");
    expect(params.get("workspaceSlug")).toBe("ws&amp=x");
    expect(params.get("orgListingId")).toBe("id?query=1");
    expect(params.get("returnTo")).toBe("/org/with slash/page?tab=a&b=2");
  });
});
