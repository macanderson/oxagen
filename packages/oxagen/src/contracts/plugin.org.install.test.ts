import { describe, expect, it } from "vitest";
import { pluginOrgInstall } from "./plugin.org.install";

describe("plugin.org.install contract", () => {
  it("registers with the correct name", () => {
    expect(pluginOrgInstall.name).toBe("plugin.org.install");
  });
  it("includes api and mcp surfaces", () => {
    expect(pluginOrgInstall.surfaces).toContain("api");
    expect(pluginOrgInstall.surfaces).toContain("mcp");
  });
  it("allows org Owner", () => {
    expect(pluginOrgInstall.defaultRoles.org.Owner).toBe("allow");
  });
  it("defaults pluginType to mcp_server", () => {
    const parsed = pluginOrgInstall.input.parse({});
    expect(parsed.pluginType).toBe("mcp_server");
  });
  it("rejects invalid pluginType", () => {
    expect(() => pluginOrgInstall.input.parse({ pluginType: "bogus" })).toThrow();
  });
});
