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
  it("allows org Owner", () => {
    expect(pluginOrgUninstall.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects missing orgListingId", () => {
    expect(() => pluginOrgUninstall.input.parse({})).toThrow();
  });
});
