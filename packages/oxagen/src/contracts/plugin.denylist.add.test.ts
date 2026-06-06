import { describe, expect, it } from "vitest";
import { pluginDenylistAdd } from "./plugin.denylist.add";

describe("plugin.denylist.add contract", () => {
  it("registers with the correct name", () => {
    expect(pluginDenylistAdd.name).toBe("plugin.denylist.add");
  });
  it("includes api and mcp surfaces", () => {
    expect(pluginDenylistAdd.surfaces).toContain("api");
    expect(pluginDenylistAdd.surfaces).toContain("mcp");
  });
  it("allows org Owner", () => {
    expect(pluginDenylistAdd.defaultRoles.org.Owner).toBe("allow");
  });
  it("defaults pluginType to mcp_server", () => {
    const parsed = pluginDenylistAdd.input.parse({ serverName: "my-server" });
    expect(parsed.pluginType).toBe("mcp_server");
  });
  it("rejects missing serverName", () => {
    expect(() => pluginDenylistAdd.input.parse({})).toThrow();
  });
});
