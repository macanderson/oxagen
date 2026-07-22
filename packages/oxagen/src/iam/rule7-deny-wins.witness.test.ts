// rule7-deny-wins.witness.test.ts — witness tests for deny-wins ordering at
// Rule 7 (role-inherited grants).
//
// `matchingRoleGrants` spans EVERY role the principal belongs to, so a principal
// who is a member of two roles can hold conflicting effects for one capability.
// Rule 7 previously evaluated `allow` before `deny`, which made an explicit deny
// role grant unreachable whenever any other role also granted allow — silently
// voiding the deny.
//
// Rules 1-3 already apply deny-first ordering at the workspace tier, and the
// Rule 7.5 comment in resolve.ts asserts that rules 1, 2, 6 and 7 "all run first
// and hard-stop, so an owner CAN restrict themselves through config". These
// tests pin that invariant at the role tier.

import { describe, expect, it } from "vitest";
import { resolve } from "./resolve";
import type { ResolveInput, Role, RoleGrant, ResolveScope } from "./resolve";
import type { ResolvedPrincipal } from "../types";

const ORG_ID = "org_aaa";
const WORKSPACE_ID = "ws_bbb";
const PRINCIPAL_ID = "prn_ccc";
const ROLE_A = "rol_allow";
const ROLE_B = "rol_deny";
const CAPABILITY = "create_org";

const principal: ResolvedPrincipal = {
  id: PRINCIPAL_ID,
  kind: "human",
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
};

const orgScope: ResolveScope = { kind: "org", orgId: ORG_ID };

function role(id: string): Role {
  return {
    id,
    name: `Role ${id}`,
    scopeKind: "org",
    orgId: ORG_ID,
    principalIds: [PRINCIPAL_ID],
    // Non-system so the org-owner super-user rule (7.5) never masks the result.
    isSystemDefault: false,
  };
}

function roleGrant(roleId: string, effect: RoleGrant["effect"]): RoleGrant {
  return { roleId, capabilityId: CAPABILITY, effect };
}

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    principal,
    capability: CAPABILITY,
    scope: orgScope,
    grants: [],
    roles: [],
    roleGrants: [],
    policies: [],
    defaultEffect: "deny",
    ...overrides,
  };
}

describe("Rule 7 — deny wins over conflicting role grants", () => {
  it("denies when the principal holds BOTH a deny and an allow role grant", () => {
    const result = resolve(
      input({
        roles: [role(ROLE_A), role(ROLE_B)],
        roleGrants: [roleGrant(ROLE_A, "allow"), roleGrant(ROLE_B, "deny")],
      }),
    );

    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy?.rule).toBe("7:role_grant");
  });

  it("denies regardless of which role is listed first", () => {
    // Guards against the fix accidentally depending on array order.
    const result = resolve(
      input({
        roles: [role(ROLE_B), role(ROLE_A)],
        roleGrants: [roleGrant(ROLE_B, "deny"), roleGrant(ROLE_A, "allow")],
      }),
    );

    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy?.rule).toBe("7:role_grant");
  });

  it("denies when the principal holds BOTH a deny and a require_approval grant", () => {
    const result = resolve(
      input({
        roles: [role(ROLE_A), role(ROLE_B)],
        roleGrants: [
          roleGrant(ROLE_A, "require_approval"),
          roleGrant(ROLE_B, "deny"),
        ],
      }),
    );

    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy?.rule).toBe("7:role_grant");
  });

  it("require_approval takes precedence over allow when no deny is present", () => {
    const result = resolve(
      input({
        roles: [role(ROLE_A), role(ROLE_B)],
        roleGrants: [
          roleGrant(ROLE_A, "allow"),
          roleGrant(ROLE_B, "require_approval"),
        ],
      }),
    );

    expect(result.outcome).toBe("pending_approval");
    expect(result.trace.decidedBy?.rule).toBe("7:role_grant");
  });

  // ── Non-regression: single-effect cases must behave exactly as before ────────

  it("still allows when the only role grant is allow", () => {
    const result = resolve(
      input({
        roles: [role(ROLE_A)],
        roleGrants: [roleGrant(ROLE_A, "allow")],
      }),
    );

    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy?.rule).toBe("7:role_grant");
  });

  it("still denies when the only role grant is deny", () => {
    const result = resolve(
      input({ roles: [role(ROLE_B)], roleGrants: [roleGrant(ROLE_B, "deny")] }),
    );

    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy?.rule).toBe("7:role_grant");
  });

  it("still returns pending_approval when the only role grant is require_approval", () => {
    const result = resolve(
      input({
        roles: [role(ROLE_A)],
        roleGrants: [roleGrant(ROLE_A, "require_approval")],
      }),
    );

    expect(result.outcome).toBe("pending_approval");
    expect(result.trace.decidedBy?.rule).toBe("7:role_grant");
  });

  it("falls through to defaultEffect when no role grant matches the capability", () => {
    const result = resolve(
      input({
        roles: [role(ROLE_A)],
        roleGrants: [
          {
            roleId: ROLE_A,
            capabilityId: "some_other_capability",
            effect: "deny",
          },
        ],
      }),
    );

    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy?.rule).not.toBe("7:role_grant");
  });
});
