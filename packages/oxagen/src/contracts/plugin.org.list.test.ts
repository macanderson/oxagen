import { describe, expect, it } from "vitest";
import { pluginOrgList } from "./plugin.org.list";

describe("plugin.org.list contract", () => {
  it("registers with api+mcp+agent surfaces and org admin roles", () => {
    expect(pluginOrgList.name).toBe("plugin.org.list");
    expect(pluginOrgList.surfaces).toContain("api");
    expect(pluginOrgList.surfaces).toContain("mcp");
    expect(pluginOrgList.surfaces).toContain("agent");
    expect(pluginOrgList.defaultRoles.org.Owner).toBe("allow");
    expect(pluginOrgList.defaultRoles.org.Admin).toBe("allow");
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

  it("rejects an invalid pluginType", () => {
    expect(() => pluginOrgList.input.parse({ pluginType: "bogus" })).toThrow();
  });

  it("output schema validates a minimal listings + denylist payload", () => {
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
          workspaceId: null,
          pluginType: "mcp_server",
          catalogServerId: null,
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
      denylist: [
        {
          id: "uuid-2",
          publicId: "pden_xyz",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdByUserId: null,
          updatedByUserId: null,
          orgId: "org-uuid",
          pluginType: "mcp_server",
          serverName: "bad-server",
          reason: null,
        },
      ],
    });
    expect(out.listings).toHaveLength(1);
    expect(out.denylist).toHaveLength(1);
  });
});
