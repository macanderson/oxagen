import { describe, expect, it } from "vitest";
import { pluginWorkspaceSetEnabled } from "./plugin.workspace.set_enabled";

describe("plugin.workspace.set_enabled contract", () => {
  it("registers with the correct name", () => {
    expect(pluginWorkspaceSetEnabled.name).toBe("set_workspace_plugin_enabled");
  });

  it("includes api and mcp surfaces", () => {
    expect(pluginWorkspaceSetEnabled.surfaces).toContain("api");
    expect(pluginWorkspaceSetEnabled.surfaces).toContain("mcp");
  });

  it("is workspace-scoped", () => {
    expect(pluginWorkspaceSetEnabled.scoped).toBe(true);
  });

  it("allows org Owner and workspace Owner/Admin", () => {
    expect(pluginWorkspaceSetEnabled.defaultRoles.org.Owner).toBe("allow");
    expect(pluginWorkspaceSetEnabled.defaultRoles.workspace.Owner).toBe("allow");
    expect(pluginWorkspaceSetEnabled.defaultRoles.workspace.Admin).toBe("allow");
  });

  it("rejects missing enabled field", () => {
    expect(() => pluginWorkspaceSetEnabled.input.parse({ orgListingId: "x" })).toThrow();
  });

  it("accepts valid input", () => {
    const parsed = pluginWorkspaceSetEnabled.input.parse({ orgListingId: "porg-1", enabled: false });
    expect(parsed.enabled).toBe(false);
  });
});
