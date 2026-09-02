import { describe, expect, it } from "vitest";
import { pluginCredentialReauth } from "./plugin.credential.reauth";

describe("plugin.credential.reauth contract", () => {
  it("registers with the correct name", () => {
    expect(pluginCredentialReauth.name).toBe("reauth_plugin_credential");
  });

  it("includes api and mcp surfaces", () => {
    expect(pluginCredentialReauth.surfaces).toContain("api");
    expect(pluginCredentialReauth.surfaces).toContain("mcp");
  });

  it("allows org Owner and Admin", () => {
    expect(pluginCredentialReauth.defaultRoles.org.Owner).toBe("allow");
    expect(pluginCredentialReauth.defaultRoles.org.Admin).toBe("allow");
  });

  it("is scoped (workspaceId required)", () => {
    expect(pluginCredentialReauth.scoped).toBe(true);
  });

  it("requires orgListingId in input", () => {
    expect(() => pluginCredentialReauth.input.parse({})).toThrow();
    expect(() =>
      pluginCredentialReauth.input.parse({ orgListingId: "" }),
    ).toThrow();
  });

  it("accepts a valid orgListingId", () => {
    const parsed = pluginCredentialReauth.input.parse({
      orgListingId: "ol-123",
    });
    expect(parsed.orgListingId).toBe("ol-123");
  });

  it("output schema validates a URL", () => {
    const out = pluginCredentialReauth.output.parse({
      authorizeUrl:
        "https://app.oxagen.ai/api/v1/mcp/oauth/authorize?orgSlug=acme&workspaceSlug=main&orgListingId=ol-1",
    });
    expect(out.authorizeUrl).toContain("authorize");
  });

  it("output schema rejects a non-URL", () => {
    expect(() =>
      pluginCredentialReauth.output.parse({ authorizeUrl: "not-a-url" }),
    ).toThrow();
  });
});
