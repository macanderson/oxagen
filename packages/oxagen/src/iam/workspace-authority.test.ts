// workspace-authority.test.ts — the workspace Owner and Admin rule (#5228):
// the shared predicates, and rule 7.6 of the pure resolver.
//
// Rule 7.6 admits a human who holds the system workspace Owner or Admin role
// on the call's own workspace, for a capability that acts inside it. Every
// condition is tested on its own here, positive and negative. The walks over
// every registered capability live with the seams that read the rule:
// packages/iam/src/workspace-authority.walk.test.ts.

import { describe, expect, it } from "vitest";
import { ORG_ONLY_WORKSPACE_ID, type ResolvedPrincipal } from "../types";
import {
  resolve,
  workspaceFullAccessGrant,
  type ResolveInput,
  type Role,
  type RoleGrant,
} from "./resolve";
import {
  actsInWorkspace,
  isRealWorkspaceId,
  membershipFullAccessRole,
  workspaceFullAccessRole,
} from "./workspace-authority";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const WS = "00000000-0000-4000-8000-0000000000b1";
const OTHER_WS = "00000000-0000-4000-8000-0000000000b2";
const PRN = "00000000-0000-4000-8000-0000000000c1";

const human: ResolvedPrincipal = {
  id: PRN,
  kind: "human",
  orgId: ORG,
  workspaceId: null,
};

function workspaceRole(name: string, overrides: Partial<Role> = {}): Role {
  return {
    id: `rol_ws_${name.toLowerCase()}`,
    name,
    scopeKind: "workspace",
    orgId: ORG,
    principalIds: [PRN],
    isSystemDefault: true,
    ...overrides,
  };
}

/** A workspace capability, an Owner or Admin on WS, and no grant at all. */
function input(
  roleName: string,
  overrides: Partial<ResolveInput> = {},
): ResolveInput {
  const role = workspaceRole(roleName);
  return {
    principal: human,
    capability: "update_toolbelt",
    scope: { kind: "workspace", orgId: ORG, workspaceId: WS },
    grants: [],
    roles: [role],
    roleGrants: [],
    policies: [],
    defaultEffect: "deny",
    actsInWorkspace: true,
    workspaceRoleIds: [role.id],
    ...overrides,
  };
}

describe("isRealWorkspaceId", () => {
  it("accepts a workspace uuid", () => {
    expect(isRealWorkspaceId(WS)).toBe(true);
  });

  it("refuses the org-only sentinel, an empty id, a non-uuid and nothing (negative)", () => {
    expect(isRealWorkspaceId(ORG_ONLY_WORKSPACE_ID)).toBe(false);
    expect(isRealWorkspaceId("")).toBe(false);
    expect(isRealWorkspaceId("ws_123")).toBe(false);
    expect(isRealWorkspaceId(undefined)).toBe(false);
    expect(isRealWorkspaceId(null)).toBe(false);
  });
});

describe("actsInWorkspace", () => {
  it("is true unless the contract says otherwise", () => {
    expect(actsInWorkspace({ name: "import_tools" })).toBe(true);
    expect(actsInWorkspace({ name: "import_tools", orgLevel: false })).toBe(
      true,
    );
  });

  it("is false for an org-level or platform-only contract (negative)", () => {
    expect(actsInWorkspace({ name: "purchase_credits", orgLevel: true })).toBe(
      false,
    );
    expect(
      actsInWorkspace({ name: "set_contract_terms", platformOnly: true }),
    ).toBe(false);
  });
});

describe("workspaceFullAccessRole and membershipFullAccessRole", () => {
  it("names Owner over Admin, and Admin alone", () => {
    expect(workspaceFullAccessRole(["Member", "Admin", "Owner"])).toBe("Owner");
    expect(workspaceFullAccessRole(["Admin"])).toBe("Admin");
  });

  it("names nothing for Member, Viewer, a custom role, or a lower-case name (negative)", () => {
    expect(workspaceFullAccessRole(["Member", "Viewer"])).toBeNull();
    expect(workspaceFullAccessRole(["agent.release"])).toBeNull();
    expect(workspaceFullAccessRole(["owner", "admin"])).toBeNull();
    expect(workspaceFullAccessRole([])).toBeNull();
  });

  it("reads a membership column in either casing", () => {
    expect(membershipFullAccessRole("owner")).toBe("Owner");
    expect(membershipFullAccessRole("Owner")).toBe("Owner");
    expect(membershipFullAccessRole("ADMIN")).toBe("Admin");
  });

  it("names nothing for any other membership (negative)", () => {
    for (const role of ["member", "viewer", "billing", "compliance", "", null]) {
      expect(membershipFullAccessRole(role)).toBeNull();
    }
  });
});

describe("resolve — Rule 7.6: workspace Owner or Admin", () => {
  it.each(["Owner", "Admin"])(
    "ALLOWS a workspace %s for a workspace capability no grant names",
    (name) => {
      const result = resolve(input(name));
      expect(result.outcome).toBe("allow");
      expect(result.trace.decidedBy.rule).toBe("7.6:workspace_full_access");
    },
  );

  it("names the role that decided, Owner over Admin", () => {
    const owner = workspaceRole("Owner");
    const admin = workspaceRole("Admin");
    const grant = workspaceFullAccessGrant(
      input("Owner", {
        roles: [admin, owner],
        workspaceRoleIds: [admin.id, owner.id],
      }),
    );
    expect(grant?.name).toBe("Owner");
  });

  it("does not apply to Member or Viewer (negative)", () => {
    for (const name of ["Member", "Viewer"]) {
      const result = resolve(input(name));
      expect(result.outcome).toBe("deny");
      expect(result.trace.decidedBy.rule).toBe("8:default");
    }
  });

  it("does not apply to an org-level capability (negative)", () => {
    const result = resolve(input("Owner", { actsInWorkspace: false }));
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });

  it("does not apply when the caller did not say the capability acts in a workspace (negative)", () => {
    const { actsInWorkspace: _omitted, ...rest } = input("Owner");
    const result = resolve(rest);
    expect(result.outcome).toBe("deny");
  });

  it("does not apply to another workspace (negative)", () => {
    // The role is held on WS; the call is on OTHER_WS. fetchAuthz pins
    // `workspaceRoleIds` to the call's workspace, so none are listed.
    const result = resolve(
      input("Owner", {
        scope: { kind: "workspace", orgId: ORG, workspaceId: OTHER_WS },
        workspaceRoleIds: [],
      }),
    );
    expect(result.outcome).toBe("deny");
  });

  it("does not apply to an org-wide assignment of the workspace role (negative)", () => {
    // `principalIds` counts an assignment with no workspace too; only the
    // workspace-pinned ids count for rule 7.6.
    const result = resolve(input("Owner", { workspaceRoleIds: undefined }));
    expect(result.outcome).toBe("deny");
  });

  it("does not apply to an org-only call or an org scope (negative)", () => {
    expect(
      resolve(
        input("Owner", {
          scope: {
            kind: "workspace",
            orgId: ORG,
            workspaceId: ORG_ONLY_WORKSPACE_ID,
          },
        }),
      ).outcome,
    ).toBe("deny");
    expect(
      resolve(input("Owner", { scope: { kind: "org", orgId: ORG } })).outcome,
    ).toBe("deny");
  });

  it("does not apply to a custom role, whatever its name (negative)", () => {
    const custom = workspaceRole("Owner", { isSystemDefault: false });
    const result = resolve(
      input("Owner", { roles: [custom], workspaceRoleIds: [custom.id] }),
    );
    expect(result.outcome).toBe("deny");
  });

  it("does not apply to an org-scoped role named Owner or Admin (negative)", () => {
    const orgAdmin = workspaceRole("Admin", { scopeKind: "org" });
    const result = resolve(
      input("Admin", { roles: [orgAdmin], workspaceRoleIds: [orgAdmin.id] }),
    );
    expect(result.outcome).toBe("deny");
  });

  it("does not apply to an agent or a service principal (negative)", () => {
    for (const kind of ["agent", "service"] as const) {
      const result = resolve(
        input("Owner", { principal: { ...human, kind } }),
      );
      expect(result.outcome).toBe("deny");
    }
  });

  it("does not apply to a role the principal is not in (negative)", () => {
    const role = workspaceRole("Owner", { principalIds: ["someone-else"] });
    const result = resolve(
      input("Owner", { roles: [role], workspaceRoleIds: [role.id] }),
    );
    expect(result.outcome).toBe("deny");
  });

  it("leaves an explicit deny or approval grant in charge (negative)", () => {
    const role = workspaceRole("Owner");
    for (const effect of ["deny", "require_approval"] as const) {
      const grant: RoleGrant = {
        roleId: role.id,
        capabilityId: "update_toolbelt",
        effect,
      };
      const result = resolve(input("Owner", { roleGrants: [grant] }));
      expect(result.outcome).toBe(
        effect === "deny" ? "deny" : "pending_approval",
      );
      expect(result.trace.decidedBy.rule).toBe("7:role_grant");
    }
  });
});
