import { describe, expect, it } from "vitest";
import { pluginOrgSetEnabled } from "./plugin.org.set_enabled";

describe("plugin.org.set_enabled contract", () => {
  it("registers with the correct name", () => {
    expect(pluginOrgSetEnabled.name).toBe("plugin.org.set_enabled");
  });
  it("includes api and mcp surfaces", () => {
    expect(pluginOrgSetEnabled.surfaces).toContain("api");
    expect(pluginOrgSetEnabled.surfaces).toContain("mcp");
  });
  it("allows org Owner", () => {
    expect(pluginOrgSetEnabled.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects missing enabled field", () => {
    expect(() => pluginOrgSetEnabled.input.parse({ orgListingId: "x" })).toThrow();
  });
});
