import { describe, expect, it } from "vitest";
import { pluginRegistryAdd } from "./plugin.registry.add";

describe("plugin.registry.add contract", () => {
  it("registers with the correct name", () => {
    expect(pluginRegistryAdd.name).toBe("add_plugin_registry");
  });
  it("has api+mcp surfaces and org admin roles", () => {
    expect(pluginRegistryAdd.surfaces).toContain("api");
    expect(pluginRegistryAdd.surfaces).toContain("mcp");
    expect(pluginRegistryAdd.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects an invalid (non-URL) baseUrl", () => {
    expect(() =>
      pluginRegistryAdd.input.parse({ name: "test", baseUrl: "not-a-url" }),
    ).toThrow();
  });
  it("accepts valid input", () => {
    const parsed = pluginRegistryAdd.input.parse({
      name: "My Registry",
      baseUrl: "https://registry.example.com",
    });
    expect(parsed.name).toBe("My Registry");
    expect(parsed.baseUrl).toBe("https://registry.example.com");
  });
});
