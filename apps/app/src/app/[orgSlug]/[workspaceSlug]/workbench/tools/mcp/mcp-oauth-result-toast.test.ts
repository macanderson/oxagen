/**
 * mcp-oauth-result-toast.test.ts — unit tests for the pure reason-code →
 * user-facing copy mapping. The component itself is covered by the MCP page
 * e2e flow; this pins the copy contract with the authorize route's
 * classifyAuthError codes.
 */
import { describe, expect, it } from "vitest";
import { oauthErrorDescription } from "./mcp-oauth-result-toast";

describe("oauthErrorDescription", () => {
  it("explains dcr_unsupported in customer-safe terms without leaking internals", () => {
    const msg = oauthErrorDescription("dcr_unsupported", "GitHub MCP");
    expect(msg).toContain("GitHub MCP");
    expect(msg).toContain("one-time setup on Oxagen");
    expect(msg).toContain("contact Oxagen support");
    // The internal platform env-var name must never reach end-user copy — it's
    // an Oxagen-operator action, logged server-side in the authorize route.
    expect(msg).not.toContain("MCP_OAUTH_PREREGISTERED_CLIENTS");
  });

  it("explains not_permitted with the ask-an-admin remedy", () => {
    const msg = oauthErrorDescription("not_permitted", "Linear MCP");
    expect(msg).toContain("Linear MCP");
    expect(msg).toContain("permission");
    expect(msg).toContain("owner or admin");
  });

  it("explains not_found as an uninstalled server", () => {
    const msg = oauthErrorDescription("not_found", "Linear MCP");
    expect(msg).toContain("Linear MCP");
    expect(msg).toContain("could not be found");
  });

  it("points provider_error at the endpoint URL", () => {
    const msg = oauthErrorDescription("provider_error", "Acme MCP");
    expect(msg).toContain("Acme MCP");
    expect(msg).toContain("endpoint URL");
  });

  it("explains no_redirect", () => {
    const msg = oauthErrorDescription("no_redirect", "Acme MCP");
    expect(msg).toContain("did not provide a sign-in page");
  });

  it("falls back to the generic retry copy for unknown or missing reasons", () => {
    expect(oauthErrorDescription(null, "Acme MCP")).toBe(
      "Acme MCP could not be connected. Try authenticating again.",
    );
    expect(oauthErrorDescription("something_new", "Acme MCP")).toBe(
      "Acme MCP could not be connected. Try authenticating again.",
    );
  });
});
