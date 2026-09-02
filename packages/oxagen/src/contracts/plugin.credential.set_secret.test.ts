import { describe, expect, it } from "vitest";
import { pluginCredentialSetSecret } from "./plugin.credential.set_secret";

describe("plugin.credential.set_secret contract", () => {
  it("registers with the correct name", () => {
    expect(pluginCredentialSetSecret.name).toBe("set_plugin_secret");
  });
  it("includes api and mcp surfaces", () => {
    expect(pluginCredentialSetSecret.surfaces).toContain("api");
    expect(pluginCredentialSetSecret.surfaces).toContain("mcp");
  });
  it("allows org Owner", () => {
    expect(pluginCredentialSetSecret.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects invalid authKind", () => {
    expect(() =>
      pluginCredentialSetSecret.input.parse({
        orgListingId: "x",
        authKind: "none",
      }),
    ).toThrow();
  });
});
