import { describe, expect, it } from "vitest";
import { toolRelayRevoke } from "./tool.relay.revoke";

const PUBLIC_ID = "rly_0123456789abcdefghjkmn";

describe("toolRelayRevoke", () => {
  it("registers revoke_relay on the API and MCP", () => {
    expect(toolRelayRevoke.name).toBe("revoke_relay");
    expect(toolRelayRevoke.surfaces).toEqual(["api", "mcp"]);
    expect(toolRelayRevoke.layers).toContain("mcp");
    expect(toolRelayRevoke.mutates).toBe(true);
    expect(toolRelayRevoke.defaultEffect).toBe("deny");
    expect(toolRelayRevoke.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(toolRelayRevoke.agent).toEqual({
      requiresApproval: true,
      riskLevel: "high",
      category: "governance",
    });
    expect(toolRelayRevoke.audit).toEqual({
      targetKind: "relay",
      targetIdField: "name",
    });
  });

  it("tells the caller when the broker drops the relay", () => {
    expect(toolRelayRevoke.description).toContain("next connect");
    expect(toolRelayRevoke.description).toContain("within 30 seconds");
  });

  it("takes a relay name and answers the revoked row", () => {
    expect(toolRelayRevoke.input.parse({ name: "office-lan" }).name).toBe(
      "office-lan",
    );
    expect(toolRelayRevoke.input.safeParse({ name: "Office" }).success).toBe(
      false,
    );
    expect(
      toolRelayRevoke.input.safeParse({ name: "office", publicId: PUBLIC_ID })
        .success,
    ).toBe(false);
    expect(
      toolRelayRevoke.output.parse({
        publicId: PUBLIC_ID,
        name: "office-lan",
        revokedAt: "2026-09-28T18:05:00.000Z",
      }).publicId,
    ).toBe(PUBLIC_ID);
  });
});
