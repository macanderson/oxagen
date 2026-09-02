import { describe, expect, it } from "vitest";
import { pluginCatalogGet } from "./plugin.catalog.get";

describe("plugin.catalog.get contract", () => {
  it("registers with the correct name", () => {
    expect(pluginCatalogGet.name).toBe("get_catalog_plugin");
  });
  it("has api+mcp surfaces and org admin roles", () => {
    expect(pluginCatalogGet.surfaces).toContain("api");
    expect(pluginCatalogGet.surfaces).toContain("mcp");
    expect(pluginCatalogGet.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects input missing name", () => {
    expect(() => pluginCatalogGet.input.parse({})).toThrow();
  });
  it("accepts a valid name+version", () => {
    const parsed = pluginCatalogGet.input.parse({
      name: "@anthropic-ai/model-context-protocol-servers-brave-search",
      version: "1.0.0",
    });
    expect(parsed.name).toBe(
      "@anthropic-ai/model-context-protocol-servers-brave-search",
    );
    expect(parsed.version).toBe("1.0.0");
  });
  it("defaults version to 'latest' when omitted", () => {
    const parsed = pluginCatalogGet.input.parse({ name: "some-server" });
    expect(parsed.version).toBe("latest");
  });
});
