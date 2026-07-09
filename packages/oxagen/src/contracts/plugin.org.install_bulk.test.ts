import { describe, expect, it } from "vitest";
import { pluginOrgInstallBulk } from "./plugin.org.install_bulk";

describe("plugin.org.install_bulk contract", () => {
  it("registers with the correct name", () => {
    expect(pluginOrgInstallBulk.name).toBe("install_plugins_bulk");
  });
  it("includes api and mcp surfaces", () => {
    expect(pluginOrgInstallBulk.surfaces).toContain("api");
    expect(pluginOrgInstallBulk.surfaces).toContain("mcp");
  });
  it("allows org Owner", () => {
    expect(pluginOrgInstallBulk.defaultRoles.org.Owner).toBe("allow");
  });
  it("rejects empty items array", () => {
    expect(() => pluginOrgInstallBulk.input.parse({ items: [] })).toThrow();
  });
  it("rejects items array over 50", () => {
    const items = Array.from({ length: 51 }, () => ({ catalogServerId: "c" }));
    expect(() => pluginOrgInstallBulk.input.parse({ items })).toThrow();
  });

  // ── Output shape regression guard ───────────────────────────────────────────
  // The handler returns `{ pluginId, orgListingId, authKind, error }` per item
  // (installOne resolves { id, authKind }; the error path returns authKind: null).
  // The output schema previously named the first field `catalogServerId`, so every
  // real handler result failed output validation ("expected string, received
  // undefined, path catalogServerId"), making bulk install unusable. These tests
  // assert the schema matches the handler's actual return shape — including the
  // authKind field the handler surfaces so the app can drive OAuth/secret setup.
  it("accepts the handler's real installed[] shape (pluginId, authKind, nullable)", () => {
    const parsed = pluginOrgInstallBulk.output.parse({
      installed: [
        { pluginId: "oxagen/media-image", orgListingId: "listing-1", authKind: "none", error: null },
        { pluginId: null, orgListingId: null, authKind: null, error: "boom" },
      ],
    });
    expect(parsed.installed).toHaveLength(2);
    expect(parsed.installed[0]?.pluginId).toBe("oxagen/media-image");
    expect(parsed.installed[1]?.pluginId).toBeNull();
  });

  it("requires pluginId (not catalogServerId) on each installed item", () => {
    // The old, broken output shape — catalogServerId with no pluginId — must fail.
    expect(() =>
      pluginOrgInstallBulk.output.parse({
        installed: [{ catalogServerId: "srv1", orgListingId: "listing-1", error: null }],
      }),
    ).toThrow();
  });
});
