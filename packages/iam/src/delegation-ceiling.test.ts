// The rule behind assign_agent_role, create_role and set_role_grants: a
// granter cannot hand out an outcome less restrictive than their own.
import { describe, expect, it } from "vitest";
import "@oxagen/oxagen";
import {
  findDelegationCeilingViolations,
  type DelegationCeilingReads,
} from "./delegation-ceiling";

const ORG = "00000000-0000-0000-0000-00000000000a";
const WS = "00000000-0000-0000-0000-00000000000b";
const USER = "00000000-0000-0000-0000-00000000000c";
const PRINCIPAL = "00000000-0000-0000-0000-00000000000d";

type Fixture = {
  principal: string | null;
  roles: Array<{
    id: string;
    name: string;
    scopeKind: "org" | "workspace";
    isSystemDefault: boolean;
    held: boolean;
    grants: Array<{
      capabilityId: string;
      effect: "allow" | "deny" | "require_approval";
    }>;
  }>;
};

function reads(f: Fixture): DelegationCeilingReads {
  return {
    assignerPrincipalId: async () => f.principal,
    orgRoles: async () =>
      f.roles.map((r) => ({
        id: r.id,
        name: r.name,
        scopeKind: r.scopeKind,
        orgId: ORG,
        isSystemDefault: r.isSystemDefault,
      })),
    assignerRoleIds: async () => f.roles.filter((r) => r.held).map((r) => r.id),
    roleGrantsOn: async (roleIds, capabilityIds) =>
      f.roles
        .filter((r) => roleIds.includes(r.id))
        .flatMap((r) =>
          r.grants
            .filter((g) => capabilityIds.includes(g.capabilityId))
            .map((g) => ({ roleId: r.id, ...g })),
        ),
  };
}

const check = (
  f: Fixture,
  conferred: Array<{
    capabilityId: string;
    effect: "allow" | "deny" | "require_approval";
  }>,
) =>
  findDelegationCeilingViolations(reads(f), {
    orgId: ORG,
    workspaceId: WS,
    userId: USER,
    conferred,
  });

describe("findDelegationCeilingViolations", () => {
  it("lets a granter confer what their own role allows", async () => {
    const f: Fixture = {
      principal: PRINCIPAL,
      roles: [
        {
          id: "r-admin",
          name: "Admin",
          scopeKind: "org",
          isSystemDefault: true,
          held: true,
          grants: [{ capabilityId: "list_runs", effect: "allow" }],
        },
      ],
    };
    await expect(
      check(f, [{ capabilityId: "list_runs", effect: "allow" }]),
    ).resolves.toEqual([]);
  });

  it("names every capability the granter does not hold (negative)", async () => {
    const f: Fixture = {
      principal: PRINCIPAL,
      roles: [
        {
          id: "r-member",
          name: "Member",
          scopeKind: "org",
          isSystemDefault: true,
          held: true,
          grants: [{ capabilityId: "list_runs", effect: "allow" }],
        },
      ],
    };
    await expect(
      check(f, [
        { capabilityId: "list_runs", effect: "allow" },
        { capabilityId: "dispatch_command", effect: "allow" },
        { capabilityId: "resolve_approval", effect: "allow" },
      ]),
    ).resolves.toEqual(["dispatch_command", "resolve_approval"]);
  });

  it("treats a require_approval the granter holds as allow-above-ceiling only for a plain allow", async () => {
    const f: Fixture = {
      principal: PRINCIPAL,
      roles: [
        {
          id: "r",
          name: "Reviewer",
          scopeKind: "org",
          isSystemDefault: false,
          held: true,
          grants: [
            { capabilityId: "dispatch_command", effect: "require_approval" },
          ],
        },
      ],
    };
    await expect(
      check(f, [
        { capabilityId: "dispatch_command", effect: "require_approval" },
      ]),
    ).resolves.toEqual([]);
    await expect(
      check(f, [{ capabilityId: "dispatch_command", effect: "allow" }]),
    ).resolves.toEqual(["dispatch_command"]);
  });

  it("lets the system org Owner confer anything (resolver rule 7.5) and a role merely named Owner nothing", async () => {
    const owner = (isSystemDefault: boolean): Fixture => ({
      principal: PRINCIPAL,
      roles: [
        {
          id: "r-owner",
          name: "Owner",
          scopeKind: "org",
          isSystemDefault,
          held: true,
          grants: [],
        },
      ],
    });
    const conferred = [
      { capabilityId: "retire_agent", effect: "allow" as const },
    ];
    await expect(check(owner(true), conferred)).resolves.toEqual([]);
    await expect(check(owner(false), conferred)).resolves.toEqual([
      "retire_agent",
    ]);
  });

  it("skips deny grants (they never widen) and reports an empty set for them alone", async () => {
    const f: Fixture = { principal: null, roles: [] };
    await expect(
      check(f, [{ capabilityId: "dispatch_command", effect: "deny" }]),
    ).resolves.toEqual([]);
  });

  it("fails closed for a granter with no principal and for a capability nobody registers (negative)", async () => {
    const f: Fixture = { principal: null, roles: [] };
    await expect(
      check(f, [
        { capabilityId: "list_runs", effect: "allow" },
        { capabilityId: "no_such_capability", effect: "allow" },
      ]),
    ).resolves.toEqual(["list_runs", "no_such_capability"]);
  });
});
