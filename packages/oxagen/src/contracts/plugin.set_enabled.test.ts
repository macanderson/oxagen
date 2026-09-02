import { describe, expect, it } from "vitest";
import { pluginSetEnabled } from "./plugin.set_enabled";
import { getCapability } from "../registry";

describe("plugin.set_enabled contract", () => {
  it("registers under its canonical name", () => {
    expect(pluginSetEnabled.name).toBe("set_plugin_enabled");
    expect(getCapability("set_plugin_enabled")).toBe(pluginSetEnabled);
  });

  it("includes api and mcp surfaces", () => {
    expect(pluginSetEnabled.surfaces).toContain("api");
    expect(pluginSetEnabled.surfaces).toContain("mcp");
  });

  it("is workspace-scoped", () => {
    expect(pluginSetEnabled.scoped).toBe(true);
  });

  it("allows org Owner/Admin and workspace Owner/Admin", () => {
    expect(pluginSetEnabled.defaultRoles.org.Owner).toBe("allow");
    expect(pluginSetEnabled.defaultRoles.org.Admin).toBe("allow");
    expect(pluginSetEnabled.defaultRoles.workspace.Owner).toBe("allow");
    expect(pluginSetEnabled.defaultRoles.workspace.Admin).toBe("allow");
  });

  it("requires the scope discriminator", () => {
    expect(() =>
      pluginSetEnabled.input.parse({ orgListingId: "x", enabled: true }),
    ).toThrow();
  });

  it("rejects a scope value outside org|workspace", () => {
    expect(() =>
      pluginSetEnabled.input.parse({
        scope: "global",
        orgListingId: "x",
        enabled: true,
      }),
    ).toThrow();
  });

  it("rejects a missing enabled field", () => {
    expect(() =>
      pluginSetEnabled.input.parse({ scope: "org", orgListingId: "x" }),
    ).toThrow();
  });

  it("accepts a valid scope='org' input", () => {
    const parsed = pluginSetEnabled.input.parse({
      scope: "org",
      orgListingId: "porg-1",
      enabled: true,
    });
    expect(parsed.scope).toBe("org");
    expect(parsed.enabled).toBe(true);
  });

  it("accepts a valid scope='workspace' input", () => {
    const parsed = pluginSetEnabled.input.parse({
      scope: "workspace",
      orgListingId: "porg-1",
      enabled: false,
    });
    expect(parsed.scope).toBe("workspace");
    expect(parsed.enabled).toBe(false);
  });

  it("output carries ok and nullable workspaceServerId", () => {
    const parsed = pluginSetEnabled.output.parse({
      ok: true,
      workspaceServerId: null,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.workspaceServerId).toBeNull();
  });
});
