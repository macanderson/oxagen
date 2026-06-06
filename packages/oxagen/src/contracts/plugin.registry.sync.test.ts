import { describe, expect, it } from "vitest";
import { pluginRegistrySync } from "./plugin.registry.sync";

describe("plugin.registry.sync contract", () => {
  it("registers with the correct name", () => {
    expect(pluginRegistrySync.name).toBe("plugin.registry.sync");
  });
  it("has api+mcp surfaces and org admin roles", () => {
    expect(pluginRegistrySync.surfaces).toContain("api");
    expect(pluginRegistrySync.surfaces).toContain("mcp");
    expect(pluginRegistrySync.defaultRoles.org.Owner).toBe("allow");
  });
  it("defaults mode to incremental", () => {
    const parsed = pluginRegistrySync.input.parse({ registryId: "reg-1" });
    expect(parsed.mode).toBe("incremental");
  });
  it("rejects an invalid mode value", () => {
    expect(() => pluginRegistrySync.input.parse({ registryId: "reg-1", mode: "partial" })).toThrow();
  });
});
