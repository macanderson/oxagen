import { describe, expect, it } from "vitest";
import { pluginCredentialRevoke } from "./plugin.credential.revoke";

describe("plugin.credential.revoke contract", () => {
  it("registers with the correct name", () => {
    expect(pluginCredentialRevoke.name).toBe("revoke_plugin_credential");
  });

  it("includes api and mcp surfaces", () => {
    expect(pluginCredentialRevoke.surfaces).toContain("api");
    expect(pluginCredentialRevoke.surfaces).toContain("mcp");
  });

  it("allows org Owner and Admin", () => {
    expect(pluginCredentialRevoke.defaultRoles.org.Owner).toBe("allow");
    expect(pluginCredentialRevoke.defaultRoles.org.Admin).toBe("allow");
  });

  it("is scoped (workspaceId required)", () => {
    expect(pluginCredentialRevoke.scoped).toBe(true);
  });

  it("is high sensitivity with default-deny", () => {
    expect(pluginCredentialRevoke.sensitivity).toBe("high");
    expect(pluginCredentialRevoke.defaultEffect).toBe("deny");
  });

  it("requires orgListingId in input", () => {
    expect(() => pluginCredentialRevoke.input.parse({})).toThrow();
    expect(() =>
      pluginCredentialRevoke.input.parse({ orgListingId: "" }),
    ).toThrow();
  });

  it("accepts a valid orgListingId", () => {
    const parsed = pluginCredentialRevoke.input.parse({
      orgListingId: "ol-123",
    });
    expect(parsed.orgListingId).toBe("ol-123");
  });

  it("output schema validates a revoked flag", () => {
    expect(pluginCredentialRevoke.output.parse({ revoked: true })).toEqual({
      revoked: true,
    });
    expect(pluginCredentialRevoke.output.parse({ revoked: false })).toEqual({
      revoked: false,
    });
  });

  it("output schema rejects a non-boolean revoked", () => {
    expect(() =>
      pluginCredentialRevoke.output.parse({ revoked: "yes" }),
    ).toThrow();
    expect(() => pluginCredentialRevoke.output.parse({})).toThrow();
  });
});
