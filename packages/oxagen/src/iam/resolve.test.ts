// resolve.test.ts — comprehensive unit tests for the pure IAM resolver.
// No I/O — all data pre-fabricated.
//
// Target: >95% line coverage on resolve.ts.

import { describe, expect, it } from "vitest";
import { resolve } from "./resolve";
import type {
  ResolveInput,
  Grant,
  Role,
  RoleGrant,
  Policy,
  ResolveScope,
} from "./resolve";
import type { ResolvedPrincipal } from "../types";

type TestPrincipal = ResolvedPrincipal;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG_ID = "org_aaa";
const WORKSPACE_ID = "ws_bbb";
const PRINCIPAL_ID = "prn_ccc";
const ROLE_ID = "rol_ddd";
const CAPABILITY = "create_org";

const basePrincipal: TestPrincipal = {
  id: PRINCIPAL_ID,
  kind: "human",
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
};

const orgScope: ResolveScope = { kind: "org", orgId: ORG_ID };
const wsScope: ResolveScope = {
  kind: "workspace",
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
};

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    principalId: PRINCIPAL_ID,
    capabilityId: CAPABILITY,
    scopeKind: "org",
    scopeId: ORG_ID,
    effect: "allow",
    conditionsJsonb: null,
    expiresAt: null,
    ...overrides,
  };
}

function makeRole(overrides: Partial<Role> = {}): Role {
  return {
    id: ROLE_ID,
    name: "Owner",
    scopeKind: "org",
    orgId: ORG_ID,
    principalIds: [PRINCIPAL_ID],
    // Default to a NON-system role so the org-owner super-user rule (7.5) only
    // fires for fixtures that opt in via `isSystemDefault: true`. This keeps the
    // Rule 6/7/8 tests exercising the grant-based paths they were written for.
    isSystemDefault: false,
    ...overrides,
  };
}

function makeRoleGrant(overrides: Partial<RoleGrant> = {}): RoleGrant {
  return {
    roleId: ROLE_ID,
    capabilityId: CAPABILITY,
    effect: "allow",
    ...overrides,
  };
}

function makePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    capabilityId: CAPABILITY,
    scopeKind: "org",
    scopeId: ORG_ID,
    effect: "allow",
    enforced: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    principal: basePrincipal,
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolve — Rule 8: default effect", () => {
  it("deny with reason no_grant when defaultEffect is deny and no grants exist", () => {
    const result = resolve(baseInput());
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("no_grant");
    }
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });

  it("allows when defaultEffect is allow and no grants exist", () => {
    const result = resolve(baseInput({ defaultEffect: "allow" }));
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });

  it("returns pending_approval when defaultEffect is require_approval", () => {
    const result = resolve(baseInput({ defaultEffect: "require_approval" }));
    expect(result.outcome).toBe("pending_approval");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });
});

describe("resolve — Rule 7.5: org owner super-user", () => {
  // The system-default org "Owner" role is the organization's root principal.
  // It must resolve "allow" for ANY capability that has no explicit grant —
  // owner access is independent of per-capability default-role seeding, so a
  // capability added after the org was provisioned never locks the owner out
  // (the bug: enterprise orgs run the full resolver, and an un-seeded capability
  // fell through to a `deny` defaultEffect). Explicit denial via config still
  // wins, because all deny rules (1, 2, 6, 7) run first.
  const ownerRole = (): Role =>
    makeRole({
      name: "Owner",
      scopeKind: "org",
      isSystemDefault: true,
      principalIds: [PRINCIPAL_ID],
    });

  it("ALLOWS an org owner for a capability with no grant, despite defaultEffect deny", () => {
    const result = resolve(
      baseInput({
        roles: [ownerRole()],
        roleGrants: [],
        defaultEffect: "deny",
      }),
    );
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("7.5:org_owner_superuser");
  });

  it("ALLOWS an org owner on a workspace-scoped invocation with no grant", () => {
    const result = resolve(
      baseInput({
        scope: wsScope,
        roles: [ownerRole()],
        roleGrants: [],
        defaultEffect: "deny",
      }),
    );
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("7.5:org_owner_superuser");
  });

  it("does NOT apply to a non-system role merely named 'Owner' (falls to defaultEffect)", () => {
    const fakeOwner = makeRole({
      name: "Owner",
      scopeKind: "org",
      isSystemDefault: false,
    });
    const result = resolve(
      baseInput({ roles: [fakeOwner], defaultEffect: "deny" }),
    );
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });

  it("does NOT apply to a system-default role that is not the org Owner (e.g. Admin)", () => {
    const admin = makeRole({
      name: "Admin",
      scopeKind: "org",
      isSystemDefault: true,
    });
    const result = resolve(
      baseInput({ roles: [admin], defaultEffect: "deny" }),
    );
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });

  it("does NOT apply to a workspace-scoped role named 'Owner' (only org-scoped owners are super-users)", () => {
    const wsOwner = makeRole({
      name: "Owner",
      scopeKind: "workspace",
      isSystemDefault: true,
    });
    const result = resolve(
      baseInput({ roles: [wsOwner], defaultEffect: "deny" }),
    );
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });

  it("does NOT apply when the owner role exists but the principal is not a member", () => {
    const ownerOtherPrincipal = makeRole({
      name: "Owner",
      scopeKind: "org",
      isSystemDefault: true,
      principalIds: ["prn_someone_else"],
    });
    const result = resolve(
      baseInput({ roles: [ownerOtherPrincipal], defaultEffect: "deny" }),
    );
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });

  it("an explicit org enforced DENY policy overrides owner super-user (config wins)", () => {
    const denyPolicy = makePolicy({
      effect: "deny",
      enforced: true,
      scopeId: ORG_ID,
    });
    const result = resolve(
      baseInput({
        roles: [ownerRole()],
        policies: [denyPolicy],
        defaultEffect: "deny",
      }),
    );
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("2:org_enforced_deny");
  });

  it("an explicit Owner-role DENY grant overrides owner super-user (config wins)", () => {
    const denyRoleGrant = makeRoleGrant({ roleId: ROLE_ID, effect: "deny" });
    const result = resolve(
      baseInput({
        roles: [ownerRole()],
        roleGrants: [denyRoleGrant],
        defaultEffect: "deny",
      }),
    );
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("7:role_grant");
  });

  it("a workspace explicit DENY grant overrides owner super-user (config wins)", () => {
    const wsDeny = makeGrant({
      scopeKind: "workspace",
      scopeId: WORKSPACE_ID,
      effect: "deny",
    });
    const result = resolve(
      baseInput({
        scope: wsScope,
        roles: [ownerRole()],
        grants: [wsDeny],
        defaultEffect: "deny",
      }),
    );
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("1:workspace_deny");
  });

  it("an explicit Owner-role ALLOW grant still decides at rule 7 (before 7.5)", () => {
    const allowRoleGrant = makeRoleGrant({ roleId: ROLE_ID, effect: "allow" });
    const result = resolve(
      baseInput({
        roles: [ownerRole()],
        roleGrants: [allowRoleGrant],
        defaultEffect: "deny",
      }),
    );
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("7:role_grant");
  });
});

describe("resolve — Rule 6: org default grant", () => {
  it("allows when org grant is allow and no workspace override", () => {
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("6:org_grant");
  });

  it("inherits pending_approval from org grant", () => {
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "require_approval",
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("pending_approval");
    expect(result.trace.decidedBy.rule).toBe("6:org_grant");
  });

  it("denies when org grant effect is deny", () => {
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "deny",
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("no_grant");
    }
    expect(result.trace.decidedBy.rule).toBe("6:org_grant");
  });

  it("expired grant is skipped and falls through to rule 8 deny", () => {
    const past = new Date(Date.now() - 1000);
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
      expiresAt: past,
    });
    const result = resolve(baseInput({ grants: [grant] }));
    // The expired grant causes a deny at rule 6 with reason 'expired'.
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("expired");
    }
    expect(result.trace.decidedBy.rule).toBe("6:org_grant");
  });

  it("condition-failed grant is skipped and reported", () => {
    // A non-empty conditions object currently fails evaluation.
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
      conditionsJsonb: { requiredIp: "1.2.3.4" },
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("condition_failed");
    }
    expect(result.trace.decidedBy.rule).toBe("6:org_grant");
  });

  it("inherits org allow grant during a WORKSPACE-scoped invocation (org → workspace inheritance)", () => {
    // Regression: a principal holding only an org-level allow grant invokes a
    // capability in a workspace context (the kernel's default). The org grant
    // must be inherited via Rule 6 — it must NOT be discarded by the scope
    // filter and fall through to the contract defaultEffect (deny).
    const orgGrant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
    });
    const result = resolve(
      baseInput({ grants: [orgGrant], scope: wsScope, defaultEffect: "deny" }),
    );
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("6:org_grant");
  });

  it("inherits org deny grant during a WORKSPACE-scoped invocation when no workspace override", () => {
    const orgDeny = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "deny",
    });
    const result = resolve(
      baseInput({ grants: [orgDeny], scope: wsScope, defaultEffect: "allow" }),
    );
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("6:org_grant");
  });
});

describe("resolve — Rule 1: workspace explicit deny", () => {
  it("denies when workspace deny overrides org allow (rule 1 before rule 3)", () => {
    const orgGrant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
    });
    const wsDeny = makeGrant({
      scopeKind: "workspace",
      scopeId: WORKSPACE_ID,
      effect: "deny",
    });
    const result = resolve(
      baseInput({ grants: [orgGrant, wsDeny], scope: wsScope }),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("workspace_deny");
    }
    expect(result.trace.decidedBy.rule).toBe("1:workspace_deny");
  });

  it("does not fire rule 1 when scope is org (workspace deny only applies on workspace scope)", () => {
    const wsDeny = makeGrant({
      scopeKind: "workspace",
      scopeId: WORKSPACE_ID,
      effect: "deny",
    });
    // Scope is org — workspace grant is not relevant.
    const result = resolve(baseInput({ grants: [wsDeny], scope: orgScope }));
    // Falls through to rule 8 with no org grant.
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });
});

describe("resolve — Rule 2: org enforced deny", () => {
  it("org enforced deny beats workspace allow (rule 2 before rule 3)", () => {
    const wsAllow = makeGrant({
      scopeKind: "workspace",
      scopeId: WORKSPACE_ID,
      effect: "allow",
    });
    const policy = makePolicy({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "deny",
      enforced: true,
    });
    const result = resolve(
      baseInput({ grants: [wsAllow], policies: [policy], scope: wsScope }),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("org_enforced_deny");
    }
    expect(result.trace.decidedBy.rule).toBe("2:org_enforced_deny");
  });

  it("non-enforced org deny policy does not fire rule 2", () => {
    const wsAllow = makeGrant({
      scopeKind: "workspace",
      scopeId: WORKSPACE_ID,
      effect: "allow",
    });
    const policy = makePolicy({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "deny",
      enforced: false,
    });
    const result = resolve(
      baseInput({ grants: [wsAllow], policies: [policy], scope: wsScope }),
    );
    // Non-enforced policy is skipped; workspace allow wins at rule 3.
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("3:workspace_allow");
  });
});

describe("resolve — Rule 3: workspace explicit allow", () => {
  it("workspace allow takes precedence over org deny", () => {
    const orgDeny = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "deny",
    });
    const wsAllow = makeGrant({
      scopeKind: "workspace",
      scopeId: WORKSPACE_ID,
      effect: "allow",
    });
    const result = resolve(
      baseInput({ grants: [orgDeny, wsAllow], scope: wsScope }),
    );
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("3:workspace_allow");
  });
});

describe("resolve — Rule 4: org enforced allow", () => {
  it("org enforced allow resolves", () => {
    const policy = makePolicy({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
      enforced: true,
    });
    const result = resolve(baseInput({ policies: [policy] }));
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("4:org_enforced_allow");
  });
});

describe("resolve — Rule 5: workspace require_approval", () => {
  it("workspace require_approval returns pending", () => {
    const wsApproval = makeGrant({
      scopeKind: "workspace",
      scopeId: WORKSPACE_ID,
      effect: "require_approval",
    });
    const result = resolve(baseInput({ grants: [wsApproval], scope: wsScope }));
    expect(result.outcome).toBe("pending_approval");
    expect(result.trace.decidedBy.rule).toBe("5:workspace_require_approval");
  });
});

describe("resolve — capability matching is exact", () => {
  it("does NOT match a role grant keyed by a different capability name", () => {
    // Capability names are matched exactly (no alias fallback): a role_grants
    // row keyed by a name other than the invoked capability never grants access.
    const rg = makeRoleGrant({
      capabilityId: "organization.create",
      effect: "allow",
    });
    const result = resolve(
      baseInput({
        capability: "create_org",
        roles: [makeRole()],
        roleGrants: [rg],
        defaultEffect: "deny",
      }),
    );
    expect(result.outcome).toBe("deny");
  });
});

describe("resolve — Rule 7: role-inherited grant", () => {
  it("role grant allow is used when no direct grants (rule 7)", () => {
    const role = makeRole();
    const rg = makeRoleGrant({ effect: "allow" });
    const result = resolve(baseInput({ roles: [role], roleGrants: [rg] }));
    expect(result.outcome).toBe("allow");
    expect(result.trace.decidedBy.rule).toBe("7:role_grant");
  });

  it("require_approval in role grant returns pending (rule 7)", () => {
    const role = makeRole();
    const rg = makeRoleGrant({ effect: "require_approval" });
    const result = resolve(baseInput({ roles: [role], roleGrants: [rg] }));
    expect(result.outcome).toBe("pending_approval");
    expect(result.trace.decidedBy.rule).toBe("7:role_grant");
  });

  it("role grant deny causes deny (rule 7)", () => {
    const role = makeRole();
    const rg = makeRoleGrant({ effect: "deny" });
    const result = resolve(baseInput({ roles: [role], roleGrants: [rg] }));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("no_grant");
    }
    expect(result.trace.decidedBy.rule).toBe("7:role_grant");
  });

  it("principal not in role — role grant does not apply", () => {
    const role = makeRole({ principalIds: ["prn_other"] });
    const rg = makeRoleGrant({ effect: "allow" });
    const result = resolve(baseInput({ roles: [role], roleGrants: [rg] }));
    // Falls through to rule 8.
    expect(result.outcome).toBe("deny");
    expect(result.trace.decidedBy.rule).toBe("8:default");
  });
});

describe("resolve — Rule precedence: org enforced deny beats role grant allow", () => {
  it("org enforced deny (rule 2) fires before role grant allow (rule 7)", () => {
    const role = makeRole();
    const rg = makeRoleGrant({ effect: "allow" });
    const policy = makePolicy({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "deny",
      enforced: true,
    });
    const result = resolve(
      baseInput({ roles: [role], roleGrants: [rg], policies: [policy] }),
    );
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("org_enforced_deny");
    }
    expect(result.trace.decidedBy.rule).toBe("2:org_enforced_deny");
  });
});

describe("resolve — trace integrity", () => {
  it("trace contains all rules evaluated in order before the decision", () => {
    // No grants — will walk all 8 rules.
    const result = resolve(baseInput({ defaultEffect: "deny" }));
    const { steps } = result.trace;
    // We should have steps for rules 1-8 (some may be skipped for non-workspace scope).
    // For org scope: rules 1 and 3 and 5 may be no-ops but still logged.
    expect(steps.length).toBeGreaterThanOrEqual(6);
    // Last step is the decided step.
    expect(result.trace.decidedBy.rule).toBe("8:default");
    // Steps are ordered.
    const rules = steps.map((s) => s.rule);
    expect(rules[0]).toBe("1:workspace_deny");
  });

  it("trace decidedBy points to a step in the steps array", () => {
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
    });
    const result = resolve(baseInput({ grants: [grant] }));
    const { steps, decidedBy } = result.trace;
    // decidedBy must be one of the steps (same object reference).
    expect(steps).toContain(decidedBy);
  });

  it("workspace scope includes workspace-specific rule steps", () => {
    const result = resolve(
      baseInput({ scope: wsScope, defaultEffect: "deny" }),
    );
    const rules = result.trace.steps.map((s) => s.rule);
    expect(rules).toContain("1:workspace_deny");
    expect(rules).toContain("3:workspace_allow");
    expect(rules).toContain("5:workspace_require_approval");
  });
});

describe("resolve — expiry edge cases", () => {
  it("grant with future expiresAt is valid (not expired)", () => {
    const future = new Date(Date.now() + 60_000);
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
      expiresAt: future,
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("allow");
  });

  it("grant with undefined expiresAt never expires", () => {
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
      expiresAt: null,
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("allow");
  });
});

describe("resolve — conditions", () => {
  it("empty conditions object means always satisfied", () => {
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
      conditionsJsonb: {},
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("allow");
  });

  it("null conditionsJsonb means always satisfied", () => {
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
      conditionsJsonb: null,
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("allow");
  });

  it("array conditionsJsonb fails closed (returns condition_failed)", () => {
    const grant = makeGrant({
      scopeKind: "org",
      scopeId: ORG_ID,
      effect: "allow",
      conditionsJsonb: ["invalid"],
    });
    const result = resolve(baseInput({ grants: [grant] }));
    expect(result.outcome).toBe("deny");
    if (result.outcome === "deny") {
      expect(result.reason).toBe("condition_failed");
    }
  });
});
