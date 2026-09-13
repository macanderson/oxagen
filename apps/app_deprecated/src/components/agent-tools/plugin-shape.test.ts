import { describe, it, expect } from "vitest";
import { shapeInstalledPlugins, type InstalledPluginRow } from "./plugin-shape";

function row(over: Partial<InstalledPluginRow> = {}): InstalledPluginRow {
  return {
    id: "plug_1",
    name: "image-gen",
    title: "Image Generation",
    description: "Generate images",
    iconUrl: null,
    pluginType: "agent_capability",
    authKind: "none",
    enabled: true,
    ...over,
  };
}

describe("shapeInstalledPlugins", () => {
  it("returns an InstalledPlugin for each row", () => {
    const out = shapeInstalledPlugins([row({ id: "a" }), row({ id: "b" })]);
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("maps row.enabled to both enabled and wsEnabled", () => {
    const out = shapeInstalledPlugins([
      row({ id: "on", enabled: true }),
      row({ id: "off", enabled: false }),
    ]);
    expect(out.find((p) => p.id === "on")?.wsEnabled).toBe(true);
    expect(out.find((p) => p.id === "on")?.enabled).toBe(true);
    expect(out.find((p) => p.id === "off")?.wsEnabled).toBe(false);
    expect(out.find((p) => p.id === "off")?.enabled).toBe(false);
  });

  it("returns an empty array for no rows", () => {
    expect(shapeInstalledPlugins([])).toEqual([]);
  });

  it("preserves title, description, iconUrl, pluginType, authKind", () => {
    const out = shapeInstalledPlugins([
      row({
        id: "p1",
        title: "My Plugin",
        description: "Does things",
        iconUrl: "https://example.com/icon.png",
        pluginType: "mcp_server",
        authKind: "oauth",
      }),
    ]);
    expect(out[0]).toMatchObject({
      id: "p1",
      title: "My Plugin",
      description: "Does things",
      iconUrl: "https://example.com/icon.png",
      pluginType: "mcp_server",
      authKind: "oauth",
    });
  });

  it("uses name as the identifier key", () => {
    const out = shapeInstalledPlugins([row({ id: "x", name: "my-server" })]);
    expect(out[0]?.name).toBe("my-server");
  });
});
