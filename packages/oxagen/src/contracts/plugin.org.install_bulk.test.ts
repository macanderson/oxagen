import { describe, expect, it } from "vitest";
import { pluginOrgInstallBulk } from "./plugin.org.install_bulk";

describe("plugin.org.install_bulk contract", () => {
  it("registers with the correct name", () => {
    expect(pluginOrgInstallBulk.name).toBe("plugin.org.install_bulk");
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
});
