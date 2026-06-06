import { describe, expect, it } from "vitest";
import { pluginRegistryList } from "./plugin.registry.list";

describe("plugin.registry.list contract", () => {
  it("registers with the correct name", () => {
    expect(pluginRegistryList.name).toBe("plugin.registry.list");
  });
  it("has api+mcp surfaces and org admin roles", () => {
    expect(pluginRegistryList.surfaces).toContain("api");
    expect(pluginRegistryList.surfaces).toContain("mcp");
    expect(pluginRegistryList.defaultRoles.org.Owner).toBe("allow");
    expect(pluginRegistryList.defaultRoles.org.Admin).toBe("allow");
  });
  it("accepts an empty input object (no required fields)", () => {
    const parsed = pluginRegistryList.input.parse({});
    expect(parsed).toEqual({});
  });
});
