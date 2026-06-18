import { describe, expect, it } from "vitest";
import { pluginOrgUninstall } from "./plugin.org.uninstall";

describe("plugin.org.uninstall contract", () => {
  it("registers with the correct name", () => {
    expect(pluginOrgUninstall.name).toBe("plugin.org.uninstall");
  });

  it("includes api and mcp surfaces", () => {
    expect(pluginOrgUninstall.surfaces).toContain("api");
    expect(pluginOrgUninstall.surfaces).toContain("mcp");
  });

  it("is workspace-scoped", () => {
    expect(pluginOrgUninstall.scoped).toBe(true);
  });

  it("allows org Owner and workspace Owner/Admin", () => {
    expect(pluginOrgUninstall.defaultRoles.org.Owner).toBe("allow");
    expect(pluginOrgUninstall.defaultRoles.workspace.Owner).toBe("allow");
    expect(pluginOrgUninstall.defaultRoles.workspace.Admin).toBe("allow");
  });

  it("rejects missing orgListingId", () => {
    expect(() => pluginOrgUninstall.input.parse({})).toThrow();
  });

  it("accepts a valid orgListingId", () => {
    const parsed = pluginOrgUninstall.input.parse({ orgListingId: "porg-123" });
    expect(parsed.orgListingId).toBe("porg-123");
  });
});
