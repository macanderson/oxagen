import { describe, expect, it } from "vitest";
import { pluginDenylistRemove } from "./plugin.denylist.remove";

describe("plugin.denylist.remove contract", () => {
  it("registers with the correct name", () => {
    expect(pluginDenylistRemove.name).toBe("plugin.denylist.remove");
  });
  it("includes api and mcp surfaces", () => {
    expect(pluginDenylistRemove.surfaces).toContain("api");
    expect(pluginDenylistRemove.surfaces).toContain("mcp");
  });
  it("allows org Owner", () => {
    expect(pluginDenylistRemove.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects missing serverName", () => {
    expect(() => pluginDenylistRemove.input.parse({})).toThrow();
  });
});
