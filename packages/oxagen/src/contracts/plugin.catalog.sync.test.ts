import { describe, expect, it } from "vitest";
import { pluginCatalogSync } from "./plugin.catalog.sync";

describe("plugin.catalog.sync contract", () => {
  it("registers with api+mcp surfaces and org admin roles", () => {
    expect(pluginCatalogSync.name).toBe("sync_plugin_catalog");
    expect(pluginCatalogSync.surfaces).toContain("api");
    expect(pluginCatalogSync.surfaces).toContain("mcp");
    expect(pluginCatalogSync.defaultRoles.org.Owner).toBe("allow");
    expect(pluginCatalogSync.defaultRoles.org.Admin).toBe("allow");
  });

  it("is workspace-scoped and idempotent (sync mode)", () => {
    expect(pluginCatalogSync.scoped).toBe(true);
    expect(pluginCatalogSync.mode).toBe("sync");
  });

  it("defaults fullSync to false when omitted", () => {
    const parsed = pluginCatalogSync.input.parse({});
    expect(parsed.fullSync).toBe(false);
  });

  it("accepts fullSync=true", () => {
    const parsed = pluginCatalogSync.input.parse({ fullSync: true });
    expect(parsed.fullSync).toBe(true);
  });

  it("rejects a non-boolean fullSync", () => {
    expect(() => pluginCatalogSync.input.parse({ fullSync: "yes" })).toThrow();
  });

  it("validates the sync-summary output shape", () => {
    const parsed = pluginCatalogSync.output.parse({
      total: 3,
      succeeded: 3,
      failed: 0,
      totalEntries: 42,
      durationMs: 120,
    });
    expect(parsed.total).toBe(3);
    expect(parsed.totalEntries).toBe(42);
  });

  it("rejects output missing required fields", () => {
    expect(() => pluginCatalogSync.output.parse({ total: 1 })).toThrow();
  });
});
