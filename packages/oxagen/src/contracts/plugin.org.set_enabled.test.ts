import { describe, expect, it } from "vitest";
import { pluginOrgSetEnabled } from "./plugin.org.set_enabled";

describe("plugin.org.set_enabled contract", () => {
  it("registers with the correct name", () => {
    expect(pluginOrgSetEnabled.name).toBe("set_org_plugin_enabled");
  });

  it("includes api and mcp surfaces", () => {
    expect(pluginOrgSetEnabled.surfaces).toContain("api");
    expect(pluginOrgSetEnabled.surfaces).toContain("mcp");
  });

  it("is workspace-scoped", () => {
    expect(pluginOrgSetEnabled.scoped).toBe(true);
  });

  it("allows org Owner and workspace Owner/Admin", () => {
    expect(pluginOrgSetEnabled.defaultRoles.org.Owner).toBe("allow");
    expect(pluginOrgSetEnabled.defaultRoles.workspace.Owner).toBe("allow");
    expect(pluginOrgSetEnabled.defaultRoles.workspace.Admin).toBe("allow");
  });

  it("rejects missing enabled field", () => {
    expect(() => pluginOrgSetEnabled.input.parse({ orgListingId: "x" })).toThrow();
  });

  it("accepts valid enable=true input", () => {
    const parsed = pluginOrgSetEnabled.input.parse({ orgListingId: "porg-1", enabled: true });
    expect(parsed.enabled).toBe(true);
  });
});
