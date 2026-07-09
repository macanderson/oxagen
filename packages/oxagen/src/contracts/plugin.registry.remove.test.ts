import { describe, expect, it } from "vitest";
import { pluginRegistryRemove } from "./plugin.registry.remove";

describe("plugin.registry.remove contract", () => {
  it("registers with the correct name", () => {
    expect(pluginRegistryRemove.name).toBe("remove_plugin_registry");
  });
  it("has api+mcp surfaces and org admin roles", () => {
    expect(pluginRegistryRemove.surfaces).toContain("api");
    expect(pluginRegistryRemove.surfaces).toContain("mcp");
    expect(pluginRegistryRemove.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects input missing registryId", () => {
    expect(() => pluginRegistryRemove.input.parse({})).toThrow();
  });
  it("accepts a valid registryId", () => {
    const parsed = pluginRegistryRemove.input.parse({ registryId: "abc-123" });
    expect(parsed.registryId).toBe("abc-123");
  });
});
