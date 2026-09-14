/**
 * agent-roles.test.ts — unit tests for the workbench/agent-roles.ts wrappers.
 *
 * Mock seams: @oxagen/oxagen → invoke (contract calls), @oxagen/billing →
 * tier, @oxagen/agent/handlers/_agent-role → the delegation-ceiling check
 * (the real one needs a live DB; here we only verify the lib wires it per
 * candidate and maps its typed rejection onto the option). The system role
 * specs (@oxagen/handlers/lib/agent-role-defaults) are the REAL shared
 * objects — asserting against them proves the picker's descriptions and
 * resource scopes can never drift from what the seeder writes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  invoke,
  resolveOrgTier,
  canAccessACL,
  assertWithinDelegationCeiling,
  resolveRoleByName,
} = vi.hoisted(() => ({
  invoke: vi.fn(),
  resolveOrgTier: vi.fn(),
  canAccessACL: vi.fn(),
  assertWithinDelegationCeiling: vi.fn(),
  resolveRoleByName: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke }));
vi.mock("@oxagen/billing", () => ({ resolveOrgTier, canAccessACL }));
vi.mock("@oxagen/agent/handlers/_agent-role", () => ({
  DEFAULT_AGENT_ROLE_NAME: "Agent Contributor",
  assertWithinDelegationCeiling,
  resolveRoleByName,
}));
vi.mock("@oxagen/database", () => ({
  withTenantDb: vi.fn((fn: (tx: Record<string, never>) => unknown) => fn({})),
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}));

import { AGENT_ROLE_SPECS } from "@oxagen/handlers/lib/agent-role-defaults";
import {
  listAgentRoleOptions,
  fallbackSystemRoleOptions,
  getAssignedAgentRole,
  getAssignedAgentRoles,
  assignAgentRole,
  revokeAgentRole,
  isCeilingError,
} from "./agent-roles";
import type { WorkbenchCtx } from "./scope";

const ctx: WorkbenchCtx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

function iamRole(overrides: Record<string, unknown>) {
  return {
    id: "rol_x",
    name: "Agent Contributor",
    description: null,
    scopeKind: "org",
    isSystemDefault: true,
    version: "1",
    memberCount: 0,
    grants: [],
    ...overrides,
  };
}

const SYSTEM_ROLE_ROWS = AGENT_ROLE_SPECS.map((spec) =>
  iamRole({
    name: spec.name,
    grants: [{ capability: "graph.search", effect: "allow" }],
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listAgentRoleOptions", () => {
  it("returns the three system roles (spec descriptions + resource scopes, grants from list_iam_roles) on a non-enterprise tier", async () => {
    resolveOrgTier.mockResolvedValue("pro");
    canAccessACL.mockReturnValue(false);
    invoke.mockResolvedValue({
      roles: [
        ...SYSTEM_ROLE_ROWS,
        iamRole({ name: "Owner" }), // human org role — never a candidate
        iamRole({ name: "Release Ops", isSystemDefault: false }),
      ],
      total: 5,
      hasMore: false,
      limit: 200,
      offset: 0,
    });

    const res = await listAgentRoleOptions(ctx);

    expect(invoke).toHaveBeenCalledWith(
      "list_iam_roles",
      { includeGrants: true, limit: 200, offset: 0 },
      ctx,
      { surface: "agent" },
    );
    expect(res.customRolesAvailable).toBe(false);
    expect(res.options.map((o) => o.roleName)).toEqual(
      AGENT_ROLE_SPECS.map((s) => s.name),
    );
    for (const [i, option] of res.options.entries()) {
      expect(option.description).toBe(AGENT_ROLE_SPECS[i]!.description);
      expect(option.resourceScope).toEqual(AGENT_ROLE_SPECS[i]!.resourceScope);
      expect(option.grants).toEqual([
        { capability: "graph.search", effect: "allow" },
      ]);
      expect(option.grantsKnown).toBe(true);
      // Non-enterprise: the human fast-path makes the ceiling vacuous.
      expect(option.withinCeiling).toBe(true);
    }
    expect(assertWithinDelegationCeiling).not.toHaveBeenCalled();
  });

  it("includes custom roles and applies the ceiling pre-check on enterprise", async () => {
    resolveOrgTier.mockResolvedValue("enterprise");
    canAccessACL.mockReturnValue(true);
    invoke.mockResolvedValue({
      roles: [
        ...SYSTEM_ROLE_ROWS,
        iamRole({
          name: "Release Ops",
          isSystemDefault: false,
          description: "Ships releases.",
        }),
      ],
      total: 4,
      hasMore: false,
      limit: 200,
      offset: 0,
    });
    resolveRoleByName.mockImplementation(
      (_tx: unknown, _orgId: string, name: string) =>
        Promise.resolve({
          id: `uuid-${name}`,
          publicId: "rol_p",
          name,
          scopeKind: "org",
          isSystemDefault: name !== "Release Ops",
        }),
    );
    // "Agent Operator" exceeds this user's own grants.
    assertWithinDelegationCeiling.mockImplementation(
      (_tx: unknown, args: { roleName: string }) => {
        if (args.roleName === "Agent Operator") {
          return Promise.reject(
            Object.assign(new Error("ceiling"), {
              code: "agent_role_ceiling_exceeded",
              capabilities: ["secret.reveal"],
            }),
          );
        }
        return Promise.resolve();
      },
    );

    const res = await listAgentRoleOptions(ctx);

    expect(res.customRolesAvailable).toBe(true);
    const names = res.options.map((o) => o.roleName);
    expect(names).toContain("Release Ops");

    const custom = res.options.find((o) => o.roleName === "Release Ops")!;
    expect(custom.isSystemDefault).toBe(false);
    expect(custom.description).toBe("Ships releases.");
    expect(custom.resourceScope).toBeNull(); // not published via a contract

    const operator = res.options.find((o) => o.roleName === "Agent Operator")!;
    expect(operator.withinCeiling).toBe(false);
    expect(operator.exceededCapabilities).toEqual(["secret.reveal"]);

    const contributor = res.options.find(
      (o) => o.roleName === "Agent Contributor",
    )!;
    expect(contributor.withinCeiling).toBe(true);
    // One ceiling check per candidate (3 system + 1 custom).
    expect(assertWithinDelegationCeiling).toHaveBeenCalledTimes(4);
  });

  it("leaves an option enabled when the pre-check fails for a non-ceiling reason (the contract stays the authority)", async () => {
    resolveOrgTier.mockResolvedValue("enterprise");
    canAccessACL.mockReturnValue(true);
    invoke.mockResolvedValue({
      roles: SYSTEM_ROLE_ROWS,
      total: 3,
      hasMore: false,
      limit: 200,
      offset: 0,
    });
    resolveRoleByName.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "agent_role_not_found" }),
    );

    const res = await listAgentRoleOptions(ctx);
    for (const option of res.options) {
      expect(option.withinCeiling).toBe(true);
    }
  });
});

describe("fallbackSystemRoleOptions", () => {
  it("returns the three system roles from the shared specs, correctly degraded", () => {
    const options = fallbackSystemRoleOptions();
    expect(options.map((o) => o.roleName)).toEqual(
      AGENT_ROLE_SPECS.map((s) => s.name),
    );
    for (const option of options) {
      expect(option.grantsKnown).toBe(false);
      expect(option.resourceScope).not.toBeNull();
      expect(option.withinCeiling).toBe(true);
    }
  });
});

describe("assignment reads & writes", () => {
  it("getAssignedAgentRole returns the newest assignment's role name", async () => {
    invoke.mockResolvedValue({
      agentId: "agt_1",
      roles: [
        { roleName: "Agent Operator" },
        { roleName: "Agent Contributor" },
      ],
      total: 2,
    });
    await expect(getAssignedAgentRole(ctx, "agt_1")).resolves.toBe(
      "Agent Operator",
    );
    expect(invoke).toHaveBeenCalledWith(
      "list_agent_roles",
      { agentId: "agt_1" },
      ctx,
      { surface: "agent" },
    );
  });

  it("getAssignedAgentRole returns null for a role-less agent", async () => {
    invoke.mockResolvedValue({ agentId: "agt_1", roles: [], total: 0 });
    await expect(getAssignedAgentRole(ctx, "agt_1")).resolves.toBeNull();
  });

  it("getAssignedAgentRoles is fail-open per agent", async () => {
    invoke
      .mockResolvedValueOnce({
        agentId: "agt_1",
        roles: [{ roleName: "Agent Observer" }],
        total: 1,
      })
      .mockRejectedValueOnce(new Error("boom"));

    const map = await getAssignedAgentRoles(ctx, ["agt_1", "agt_2"]);
    expect(map.get("agt_1")).toBe("Agent Observer");
    expect(map.get("agt_2")).toBeNull();
  });

  it("assignAgentRole / revokeAgentRole call their contracts", async () => {
    invoke.mockResolvedValue({});
    await assignAgentRole(ctx, "agt_1", "Agent Operator");
    expect(invoke).toHaveBeenCalledWith(
      "assign_agent_role",
      { agentId: "agt_1", roleName: "Agent Operator" },
      ctx,
      { surface: "agent" },
    );
    await revokeAgentRole(ctx, "agt_1", "Agent Contributor");
    expect(invoke).toHaveBeenCalledWith(
      "revoke_agent_role",
      { agentId: "agt_1", roleName: "Agent Contributor" },
      ctx,
      { surface: "agent" },
    );
  });
});

describe("isCeilingError", () => {
  it("narrows the stable ceiling rejection shape", () => {
    expect(
      isCeilingError(
        Object.assign(new Error("x"), {
          code: "agent_role_ceiling_exceeded",
          capabilities: ["a"],
        }),
      ),
    ).toBe(true);
    expect(isCeilingError(new Error("x"))).toBe(false);
    expect(isCeilingError({ code: "agent_role_ceiling_exceeded" })).toBe(false); // no capabilities array
    expect(isCeilingError(null)).toBe(false);
  });
});
