import { describe, expect, it } from "vitest";
import { pluginOrgInstall } from "./plugin.org.install";

describe("plugin.org.install contract", () => {
  it("registers with the correct name", () => {
    expect(pluginOrgInstall.name).toBe("install_plugin");
  });

  it("includes api and mcp surfaces", () => {
    expect(pluginOrgInstall.surfaces).toContain("api");
    expect(pluginOrgInstall.surfaces).toContain("mcp");
  });

  it("is workspace-scoped", () => {
    expect(pluginOrgInstall.scoped).toBe(true);
  });

  it("allows org Owner and workspace Owner/Admin", () => {
    expect(pluginOrgInstall.defaultRoles.org.Owner).toBe("allow");
    expect(pluginOrgInstall.defaultRoles.workspace.Owner).toBe("allow");
    expect(pluginOrgInstall.defaultRoles.workspace.Admin).toBe("allow");
  });

  it("defaults pluginType to mcp_server", () => {
    const parsed = pluginOrgInstall.input.parse({});
    expect(parsed.pluginType).toBe("mcp_server");
  });

  it("accepts agent_capability pluginType", () => {
    const parsed = pluginOrgInstall.input.parse({
      pluginType: "agent_capability",
    });
    expect(parsed.pluginType).toBe("agent_capability");
  });

  it("rejects invalid pluginType", () => {
    expect(() =>
      pluginOrgInstall.input.parse({ pluginType: "bogus" }),
    ).toThrow();
  });

  it("rejects legacy 'capability' pluginType (renamed to agent_capability)", () => {
    expect(() =>
      pluginOrgInstall.input.parse({ pluginType: "capability" }),
    ).toThrow();
  });

  it("rejects a spoofed workspaceId in input (scope comes from ctx)", () => {
    // Input schema no longer accepts workspaceId — IDOR prevention.
    const parsed = pluginOrgInstall.input.parse({
      workspaceId: "ws-spoofed",
    } as Record<string, unknown>);
    expect((parsed as Record<string, unknown>).workspaceId).toBeUndefined();
  });

  it("rejects a catalogServerId in input (column removed in schema rebuild)", () => {
    // catalogServerId was removed from installed_plugins.
    const parsed = pluginOrgInstall.input.parse({
      catalogServerId: "cs-1",
    } as Record<string, unknown>);
    expect((parsed as Record<string, unknown>).catalogServerId).toBeUndefined();
  });
});
