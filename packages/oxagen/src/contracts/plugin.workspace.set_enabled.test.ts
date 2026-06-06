import { describe, expect, it } from "vitest";
import { pluginWorkspaceSetEnabled } from "./plugin.workspace.set_enabled";

describe("plugin.workspace.set_enabled contract", () => {
  it("registers with the correct name", () => {
    expect(pluginWorkspaceSetEnabled.name).toBe("plugin.workspace.set_enabled");
  });
  it("includes api and mcp surfaces", () => {
    expect(pluginWorkspaceSetEnabled.surfaces).toContain("api");
    expect(pluginWorkspaceSetEnabled.surfaces).toContain("mcp");
  });
  it("allows org Owner", () => {
    expect(pluginWorkspaceSetEnabled.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects missing enabled field", () => {
    expect(() => pluginWorkspaceSetEnabled.input.parse({ orgListingId: "x" })).toThrow();
  });
});
