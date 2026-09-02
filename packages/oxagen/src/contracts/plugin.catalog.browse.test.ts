import { describe, expect, it } from "vitest";
import { pluginCatalogBrowse } from "./plugin.catalog.browse";

describe("plugin.catalog.browse contract", () => {
  it("registers with api+mcp surfaces and org admin roles", () => {
    expect(pluginCatalogBrowse.name).toBe("browse_plugin_catalog");
    expect(pluginCatalogBrowse.surfaces).toContain("api");
    expect(pluginCatalogBrowse.surfaces).toContain("mcp");
    expect(pluginCatalogBrowse.defaultRoles.org.Owner).toBe("allow");
  });
  it("applies input defaults (limit 30, offset 0)", () => {
    const parsed = pluginCatalogBrowse.input.parse({});
    expect(parsed.limit).toBe(30);
    expect(parsed.offset).toBe(0);
  });
  it("rejects an invalid authKind", () => {
    expect(() =>
      pluginCatalogBrowse.input.parse({ authKind: "bogus" }),
    ).toThrow();
  });
});
