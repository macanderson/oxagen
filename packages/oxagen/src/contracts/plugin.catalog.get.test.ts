import { describe, expect, it } from "vitest";
import { pluginCatalogGet } from "./plugin.catalog.get";

describe("plugin.catalog.get contract", () => {
  it("registers with the correct name", () => {
    expect(pluginCatalogGet.name).toBe("plugin.catalog.get");
  });
  it("has api+mcp surfaces and org admin roles", () => {
    expect(pluginCatalogGet.surfaces).toContain("api");
    expect(pluginCatalogGet.surfaces).toContain("mcp");
    expect(pluginCatalogGet.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects input missing catalogId", () => {
    expect(() => pluginCatalogGet.input.parse({})).toThrow();
  });
  it("accepts a valid catalogId", () => {
    const parsed = pluginCatalogGet.input.parse({ catalogId: "mcat-abc-123" });
    expect(parsed.catalogId).toBe("mcat-abc-123");
  });
});
