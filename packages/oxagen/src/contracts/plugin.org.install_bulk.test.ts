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

  // The handler returns `{ pluginId, orgListingId, authKind, error }` per item
  // (installOne resolves { id, authKind }; the error path returns authKind: null).
  // These tests assert the output schema matches that shape, including the
  // authKind field the app needs to drive OAuth/secret setup.
  it("accepts the handler's real installed[] shape (pluginId, authKind, nullable)", () => {
    const parsed = pluginOrgInstallBulk.output.parse({
      installed: [
        {
          pluginId: "oxagen/media-image",
          orgListingId: "listing-1",
          authKind: "none",
          error: null,
        },
        { pluginId: null, orgListingId: null, authKind: null, error: "boom" },
      ],
    });
    expect(parsed.installed).toHaveLength(2);
    expect(parsed.installed[0]?.pluginId).toBe("oxagen/media-image");
    expect(parsed.installed[0]?.authKind).toBe("none");
    expect(parsed.installed[1]?.pluginId).toBeNull();
    expect(parsed.installed[1]?.authKind).toBeNull();
  });

  it("requires pluginId (not catalogServerId) on each installed item", () => {
    // The old, broken output shape — catalogServerId with no pluginId — must fail.
    expect(() =>
      pluginOrgInstallBulk.output.parse({
        installed: [
          { catalogServerId: "srv1", orgListingId: "listing-1", error: null },
        ],
      }),
    ).toThrow();
  });
});
