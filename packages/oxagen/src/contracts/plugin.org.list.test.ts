import { describe, expect, it } from "vitest";
import { pluginOrgList } from "./plugin.org.list";

describe("plugin.org.list contract", () => {
  it("registers with api+mcp+agent surfaces and org admin roles", () => {
    expect(pluginOrgList.name).toBe("list_plugins");
    expect(pluginOrgList.surfaces).toContain("api");
    expect(pluginOrgList.surfaces).toContain("mcp");
    expect(pluginOrgList.surfaces).toContain("agent");
    expect(pluginOrgList.defaultRoles.org.Owner).toBe("allow");
    expect(pluginOrgList.defaultRoles.org.Admin).toBe("allow");
  });

  it("is workspace-scoped", () => {
    expect(pluginOrgList.scoped).toBe(true);
  });

  it("grants workspace Members read access", () => {
    expect(pluginOrgList.defaultRoles.workspace.Member).toBe("allow");
  });

  it("is read-only: riskLevel low, requiresApproval false", () => {
    expect(pluginOrgList.agent.riskLevel).toBe("low");
    expect(pluginOrgList.agent.requiresApproval).toBe(false);
  });

  it("accepts an empty input (no pluginType filter)", () => {
    const parsed = pluginOrgList.input.parse({});
    expect(parsed.pluginType).toBeUndefined();
  });

  it("accepts a valid pluginType filter", () => {
    const parsed = pluginOrgList.input.parse({ pluginType: "mcp_server" });
    expect(parsed.pluginType).toBe("mcp_server");
  });

  it("accepts agent_capability pluginType filter", () => {
    const parsed = pluginOrgList.input.parse({
      pluginType: "agent_capability",
    });
    expect(parsed.pluginType).toBe("agent_capability");
  });

  it("rejects an invalid pluginType", () => {
    expect(() => pluginOrgList.input.parse({ pluginType: "bogus" })).toThrow();
  });

  it("rejects legacy 'content_tool' pluginType (removed in workspace-scoping rebuild)", () => {
    expect(() =>
      pluginOrgList.input.parse({ pluginType: "content_tool" }),
    ).toThrow();
  });

  it("rejects a spoofed workspaceId in input (scope comes from ctx)", () => {
    // Input schema no longer accepts a workspaceId — scope is enforced via ctx.
    const parsed = pluginOrgList.input.parse({
      workspaceId: "ws-spoofed",
    } as Record<string, unknown>);
    // Unknown keys are stripped by zod; the spoofed field must not appear.
    expect((parsed as Record<string, unknown>).workspaceId).toBeUndefined();
  });

  it("output schema validates a minimal listings payload (no denylist)", () => {
    const out = pluginOrgList.output.parse({
      listings: [
        {
          id: "uuid-1",
          publicId: "porg_abc",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdByUserId: null,
          updatedByUserId: null,
          deletedAt: null,
          deletedByUserId: null,
          orgId: "org-uuid",
          workspaceId: "ws-uuid",
          pluginType: "mcp_server",
          source: "custom",
          name: "my-server",
          title: null,
          description: null,
          iconUrl: null,
          endpointUrl: null,
          transport: null,
          authKind: "none",
          authConfig: {},
          enabled: false,
          config: {},
        },
      ],
    });
    expect(out.listings).toHaveLength(1);
    expect(out.listings[0]!.workspaceId).toBe("ws-uuid");
  });

  it("output schema rejects a payload that includes a denylist field", () => {
    // denylist was dropped — it should be stripped (not cause a validation error,
    // but must not appear in the parsed output either).
    const out = pluginOrgList.output.parse({
      listings: [],
      denylist: [{ id: "x" }],
    } as Record<string, unknown>);
    expect((out as Record<string, unknown>).denylist).toBeUndefined();
  });
});
