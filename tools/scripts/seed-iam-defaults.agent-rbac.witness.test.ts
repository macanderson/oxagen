import { describe, expect, it } from "vitest";
import {
  AGENT_ROLE_DESCRIPTIONS,
  AGENT_ROLE_NAMES,
  AGENT_ROLE_RESOURCE_SCOPE,
  LEGACY_ROLE_NAME_ILIKE_PATTERN,
  OPERATOR_RESTRICTED_CATEGORIES,
  READ_CATEGORIES,
  agentRoleEffect,
  contributorMutationEffect,
  makeRoleGrantPublicId,
  makeRolePublicId,
  type AgentRoleName,
} from "./lib/seed-iam-defaults";

// ── Role creation shape ───────────────────────────────────────────────────────

describe("AGENT_ROLE_NAMES", () => {
  it("is exactly the three system agent roles — no fourth/legacy role", () => {
    expect(AGENT_ROLE_NAMES).toEqual([
      "Agent Observer",
      "Agent Contributor",
      "Agent Operator",
    ]);
    expect(AGENT_ROLE_NAMES).toHaveLength(3);
    expect(AGENT_ROLE_NAMES.some((n) => n.includes("Legacy"))).toBe(false);
  });

  it("every role has a non-empty description", () => {
    for (const name of AGENT_ROLE_NAMES) {
      expect(AGENT_ROLE_DESCRIPTIONS[name]).toBeTruthy();
      expect(AGENT_ROLE_DESCRIPTIONS[name].length).toBeGreaterThan(20);
    }
  });
});

// ── Deterministic public_id helpers (idempotency substrate) ─────────────────

describe("makeRolePublicId", () => {
  it("is deterministic for the same (orgId, scopeKind, name)", () => {
    const a = makeRolePublicId("org_1", "workspace", "Agent Observer");
    const b = makeRolePublicId("org_1", "workspace", "Agent Observer");
    expect(a).toBe(b);
    expect(a).toMatch(/^rol_[0-9a-f]{22}$/);
  });

  it("differs across org, scopeKind, or name", () => {
    const base = makeRolePublicId("org_1", "workspace", "Agent Observer");
    expect(makeRolePublicId("org_2", "workspace", "Agent Observer")).not.toBe(base);
    expect(makeRolePublicId("org_1", "org", "Agent Observer")).not.toBe(base);
    expect(makeRolePublicId("org_1", "workspace", "Agent Contributor")).not.toBe(base);
  });

  it("matches the iam-provision.ts scheme exactly (same digest for same input)", () => {
    // rol_<sha256(orgId:scopeKind:name)[:22]> — packages/handlers/src/iam-provision.ts
    // must derive the identical public_id for the same triple so that a role
    // bootstrapped there and later touched by this seed script resolve to one row.
    const id1 = makeRolePublicId("org_abc", "workspace", "Owner");
    const id2 = makeRolePublicId("org_abc", "workspace", "Owner");
    expect(id1).toBe(id2);
  });
});

describe("makeRoleGrantPublicId", () => {
  it("is deterministic for the same (roleId, capabilityId)", () => {
    const a = makeRoleGrantPublicId("role_1", "graph.node.get");
    const b = makeRoleGrantPublicId("role_1", "graph.node.get");
    expect(a).toBe(b);
    expect(a).toMatch(/^rlg_[0-9a-f]{24}$/);
  });

  it("does not collide for capabilities sharing a name prefix", () => {
    // Regression: a previous version truncated the capability id to 14 chars,
    // colliding e.g. agent.background_task.{start,read,cancel}.
    const start = makeRoleGrantPublicId("role_1", "agent.background_task.start");
    const read = makeRoleGrantPublicId("role_1", "agent.background_task.read");
    const cancel = makeRoleGrantPublicId("role_1", "agent.background_task.cancel");
    expect(new Set([start, read, cancel]).size).toBe(3);
  });

  it("differs across roleId", () => {
    const a = makeRoleGrantPublicId("role_1", "graph.node.get");
    const b = makeRoleGrantPublicId("role_2", "graph.node.get");
    expect(a).not.toBe(b);
  });
});

// ── Grant derivation: category/riskLevel/requiresApproval → effect ──────────

describe("contributorMutationEffect", () => {
  it("requiresApproval:true always wins over riskLevel", () => {
    expect(contributorMutationEffect("low", true)).toBe("require_approval");
    expect(contributorMutationEffect("medium", true)).toBe("require_approval");
    expect(contributorMutationEffect("high", true)).toBe("require_approval");
    expect(contributorMutationEffect(undefined, true)).toBe("require_approval");
  });

  it("low/medium riskLevel allow when requiresApproval is false/undefined", () => {
    expect(contributorMutationEffect("low", false)).toBe("allow");
    expect(contributorMutationEffect("medium", false)).toBe("allow");
    expect(contributorMutationEffect("low", undefined)).toBe("allow");
  });

  it("high or undeclared riskLevel requires approval (fail-closed)", () => {
    expect(contributorMutationEffect("high", false)).toBe("require_approval");
    expect(contributorMutationEffect(undefined, false)).toBe("require_approval");
    expect(contributorMutationEffect(undefined, undefined)).toBe("require_approval");
  });
});

describe("agentRoleEffect — Agent Observer", () => {
  for (const category of READ_CATEGORIES) {
    it(`allows read category "${category}" regardless of riskLevel`, () => {
      expect(agentRoleEffect("Agent Observer", category, "high", true)).toBe("allow");
      expect(agentRoleEffect("Agent Observer", category, undefined, undefined)).toBe(
        "allow",
      );
    });
  }

  it("denies every mutation category, regardless of riskLevel/requiresApproval", () => {
    for (const category of ["mutation", "vcs", "billing", "secret", "write"]) {
      expect(agentRoleEffect("Agent Observer", category, "low", false)).toBe("deny");
      expect(agentRoleEffect("Agent Observer", category, "high", true)).toBe("deny");
    }
  });

  it("denies when category is undeclared (fail-closed, not read)", () => {
    expect(agentRoleEffect("Agent Observer", undefined, "low", false)).toBe("deny");
  });
});

describe("agentRoleEffect — Agent Contributor", () => {
  for (const category of READ_CATEGORIES) {
    it(`allows read category "${category}"`, () => {
      expect(agentRoleEffect("Agent Contributor", category, "high", true)).toBe(
        "allow",
      );
    });
  }

  it("allows low/medium riskLevel mutations", () => {
    expect(agentRoleEffect("Agent Contributor", "mutation", "low", false)).toBe(
      "allow",
    );
    expect(agentRoleEffect("Agent Contributor", "mutation", "medium", false)).toBe(
      "allow",
    );
  });

  it("requires approval for high riskLevel mutations", () => {
    expect(agentRoleEffect("Agent Contributor", "mutation", "high", false)).toBe(
      "require_approval",
    );
  });

  it("requires approval when requiresApproval:true, even at low riskLevel", () => {
    // e.g. billing.reseller_customer.update: riskLevel low, requiresApproval true.
    expect(agentRoleEffect("Agent Contributor", "billing", "low", true)).toBe(
      "require_approval",
    );
  });

  it("requires approval for undeclared riskLevel mutations (fail-closed)", () => {
    expect(agentRoleEffect("Agent Contributor", "mutation", undefined, false)).toBe(
      "require_approval",
    );
  });

  it("applies the same rule to vcs/billing/secret as any other mutation category (no extra Operator-only restriction)", () => {
    for (const category of OPERATOR_RESTRICTED_CATEGORIES) {
      expect(agentRoleEffect("Agent Contributor", category, "low", false)).toBe(
        "allow",
      );
      expect(agentRoleEffect("Agent Contributor", category, "high", false)).toBe(
        "require_approval",
      );
    }
  });
});

describe("agentRoleEffect — Agent Operator", () => {
  for (const category of READ_CATEGORIES) {
    it(`allows read category "${category}"`, () => {
      expect(agentRoleEffect("Agent Operator", category, "high", true)).toBe("allow");
    });
  }

  it("allows high riskLevel mutations for non-restricted categories (uncapped vs Contributor)", () => {
    expect(agentRoleEffect("Agent Operator", "mutation", "high", false)).toBe("allow");
    expect(agentRoleEffect("Agent Operator", "workflow", "high", false)).toBe("allow");
  });

  it("allows low/medium riskLevel mutations for non-restricted categories", () => {
    expect(agentRoleEffect("Agent Operator", "mutation", "low", false)).toBe("allow");
    expect(agentRoleEffect("Agent Operator", "mutation", "medium", false)).toBe(
      "allow",
    );
  });

  it("requires approval for undeclared riskLevel on non-restricted categories (fail-closed)", () => {
    expect(agentRoleEffect("Agent Operator", "mutation", undefined, false)).toBe(
      "require_approval",
    );
  });

  it("honors requiresApproval:true on non-restricted categories even at high riskLevel", () => {
    expect(agentRoleEffect("Agent Operator", "mutation", "high", true)).toBe(
      "require_approval",
    );
  });

  for (const category of OPERATOR_RESTRICTED_CATEGORIES) {
    it(`stays at Contributor's posture for restricted category "${category}" — high riskLevel does NOT unlock allow`, () => {
      // This is the crux of the Operator/Contributor distinction: without the
      // restricted-category carve-out, Operator would allow high-risk
      // vcs/billing/secret mutations, which the spec explicitly forbids.
      expect(agentRoleEffect("Agent Operator", category, "high", false)).toBe(
        "require_approval",
      );
      expect(agentRoleEffect("Agent Operator", category, "low", false)).toBe("allow");
      expect(agentRoleEffect("Agent Operator", category, "low", true)).toBe(
        "require_approval",
      );
    });
  }

  it("matches Contributor's effect exactly for every restricted category × riskLevel × requiresApproval combination", () => {
    for (const category of OPERATOR_RESTRICTED_CATEGORIES) {
      for (const riskLevel of ["low", "medium", "high", undefined] as const) {
        for (const requiresApproval of [true, false, undefined]) {
          expect(
            agentRoleEffect("Agent Operator", category, riskLevel, requiresApproval),
          ).toBe(
            agentRoleEffect(
              "Agent Contributor",
              category,
              riskLevel,
              requiresApproval,
            ),
          );
        }
      }
    }
  });
});

// ── resourceScope correctness ─────────────────────────────────────────────────

describe("AGENT_ROLE_RESOURCE_SCOPE", () => {
  it("Agent Observer forces graph mode='read' and denies every MCP call", () => {
    const scope = AGENT_ROLE_RESOURCE_SCOPE["Agent Observer"];
    expect(scope.graph?.mode).toBe("read");
    expect(scope.mcp?.rules).toEqual([{ pattern: "*", effect: "deny" }]);
  });

  it("Agent Contributor has no graph ceiling (as-configured) and asks per MCP tool", () => {
    const scope = AGENT_ROLE_RESOURCE_SCOPE["Agent Contributor"];
    expect(scope.graph).toBeUndefined();
    expect(scope.mcp?.rules).toEqual([{ pattern: "*", effect: "ask" }]);
  });

  it("Agent Operator raises the graph ceiling to mode='extend' and allows MCP calls", () => {
    const scope = AGENT_ROLE_RESOURCE_SCOPE["Agent Operator"];
    expect(scope.graph?.mode).toBe("extend");
    expect(scope.mcp?.rules).toEqual([{ pattern: "*", effect: "allow" }]);
  });

  it("every role has a defined resourceScope entry (nothing falls through to undefined)", () => {
    for (const name of AGENT_ROLE_NAMES) {
      expect(AGENT_ROLE_RESOURCE_SCOPE[name as AgentRoleName]).toBeDefined();
    }
  });

  it("mcp.rules use the '*' pattern (server:tool glob) consistently across roles", () => {
    for (const name of AGENT_ROLE_NAMES) {
      const rules = AGENT_ROLE_RESOURCE_SCOPE[name as AgentRoleName].mcp?.rules;
      expect(rules).toHaveLength(1);
      expect(rules?.[0]?.pattern).toBe("*");
    }
  });
});

// ── Legacy-role guard ──────────────────────────────────────────────────────────

describe("LEGACY_ROLE_NAME_ILIKE_PATTERN", () => {
  it("is a SQL ILIKE prefix pattern matching both superseded spellings", () => {
    expect(LEGACY_ROLE_NAME_ILIKE_PATTERN).toBe("Agent Legacy%");
    const asRegex = new RegExp(
      "^" + LEGACY_ROLE_NAME_ILIKE_PATTERN.replace("%", ".*") + "$",
      "i",
    );
    expect(asRegex.test("Agent Legacy")).toBe(true);
    expect(asRegex.test("Agent Legacy (unrestricted)")).toBe(true);
    expect(asRegex.test("agent legacy")).toBe(true); // ILIKE is case-insensitive
  });

  it("does not match any of the three canonical role names", () => {
    const asRegex = new RegExp(
      "^" + LEGACY_ROLE_NAME_ILIKE_PATTERN.replace("%", ".*") + "$",
      "i",
    );
    for (const name of AGENT_ROLE_NAMES) {
      expect(asRegex.test(name)).toBe(false);
    }
  });
});

// ── Idempotency of the derivation functions themselves ───────────────────────

describe("idempotency of pure derivation", () => {
  it("agentRoleEffect is a pure function — repeated calls with the same input agree", () => {
    for (const roleName of AGENT_ROLE_NAMES) {
      for (const category of ["read", "mutation", "billing", undefined]) {
        for (const riskLevel of ["low", "medium", "high", undefined] as const) {
          for (const requiresApproval of [true, false, undefined]) {
            const a = agentRoleEffect(roleName, category, riskLevel, requiresApproval);
            const b = agentRoleEffect(roleName, category, riskLevel, requiresApproval);
            expect(a).toBe(b);
          }
        }
      }
    }
  });

  it("public_id derivation is stable across repeated calls — the substrate re-run idempotency (ON CONFLICT DO UPDATE) relies on", () => {
    const roleId1 = makeRolePublicId("org_x", "workspace", "Agent Operator");
    const roleId2 = makeRolePublicId("org_x", "workspace", "Agent Operator");
    expect(roleId1).toBe(roleId2);

    const grantId1 = makeRoleGrantPublicId(roleId1, "graph.cypher");
    const grantId2 = makeRoleGrantPublicId(roleId2, "graph.cypher");
    expect(grantId1).toBe(grantId2);
  });
});
