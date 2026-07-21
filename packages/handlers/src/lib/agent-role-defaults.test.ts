/**
 * Unit tests for the pure Agent RBAC role-provisioning core
 * (docs/specs/agent-rbac/spec.md §3.2, §3.3), shared by
 * tools/scripts/seed-iam-defaults.ts (existing orgs) and
 * ./iam-provision.ts's bootstrapOrgIAM (new orgs).
 */
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { parseResourceScope } from "@oxagen/oxagen/iam";
import {
  AGENT_ROLE_NAMES,
  AGENT_ROLE_SPECS,
  isReadLikeCategory,
  makeAgentRolePublicId,
  makeRoleGrantPublicId,
  selectAgentCapabilities,
  type AgentRoleSpec,
} from "./agent-role-defaults";

function specFor(name: string): AgentRoleSpec {
  const spec = AGENT_ROLE_SPECS.find((s) => s.name === name);
  if (!spec) throw new Error(`no AGENT_ROLE_SPECS entry named "${name}"`);
  return spec;
}

describe("AGENT_ROLE_NAMES / AGENT_ROLE_SPECS", () => {
  it("seeds exactly the three system agent roles, no 'Agent Legacy'", () => {
    expect(AGENT_ROLE_NAMES).toEqual([
      "Agent Observer",
      "Agent Contributor",
      "Agent Operator",
    ]);
    expect(AGENT_ROLE_SPECS.map((s) => s.name)).toEqual([...AGENT_ROLE_NAMES]);
    expect(AGENT_ROLE_SPECS.some((s) => /legacy/i.test(s.name))).toBe(false);
  });

  it("every spec's resourceScope validates against the real resourceScopeSchema", () => {
    for (const spec of AGENT_ROLE_SPECS) {
      expect(parseResourceScope(spec.resourceScope)).not.toBeNull();
    }
  });

  it("Observer's resourceScope caps graph to read mode and denies all MCP", () => {
    const observer = specFor("Agent Observer");
    expect(observer.resourceScope.graph?.mode).toBe("read");
    expect(observer.resourceScope.mcp?.rules).toEqual([
      { pattern: "*", effect: "deny" },
    ]);
  });

  it("Contributor's resourceScope adds no extra graph ceiling and asks for MCP", () => {
    const contributor = specFor("Agent Contributor");
    expect(contributor.resourceScope.graph).toBeUndefined();
    expect(contributor.resourceScope.mcp?.rules).toEqual([
      { pattern: "*", effect: "ask" },
    ]);
  });

  it("Operator's resourceScope allows graph extend and allows MCP", () => {
    const operator = specFor("Agent Operator");
    expect(operator.resourceScope.graph?.mode).toBe("extend");
    expect(operator.resourceScope.mcp?.rules).toEqual([
      { pattern: "*", effect: "allow" },
    ]);
  });
});

describe("isReadLikeCategory", () => {
  it("is true for exactly the four spec-named read-like categories", () => {
    expect(isReadLikeCategory("read")).toBe(true);
    expect(isReadLikeCategory("introspection")).toBe(true);
    expect(isReadLikeCategory("graph")).toBe(true);
    expect(isReadLikeCategory("memory")).toBe(true);
  });

  it("is false for other real contract categories, including ones that are arguably reads", () => {
    expect(isReadLikeCategory("mutation")).toBe(false);
    expect(isReadLikeCategory("write")).toBe(false);
    expect(isReadLikeCategory("destructive")).toBe(false);
    expect(isReadLikeCategory("workspace")).toBe(false); // e.g. workspace.list — a read, but not in the allow-set
    expect(isReadLikeCategory("skill")).toBe(false);
    expect(isReadLikeCategory("vcs")).toBe(false);
    expect(isReadLikeCategory("billing")).toBe(false);
    expect(isReadLikeCategory("secret")).toBe(false);
    expect(isReadLikeCategory("")).toBe(false);
  });
});

describe("Agent Observer computeEffect", () => {
  const observer = specFor("Agent Observer");

  it("allows read-like categories regardless of riskLevel", () => {
    expect(observer.computeEffect("read", "low")).toBe("allow");
    expect(observer.computeEffect("introspection", "high")).toBe("allow");
    expect(observer.computeEffect("graph", "high")).toBe("allow");
    expect(observer.computeEffect("memory", "medium")).toBe("allow");
  });

  it("denies every mutation regardless of riskLevel — read/answer only", () => {
    expect(observer.computeEffect("mutation", "low")).toBe("deny");
    expect(observer.computeEffect("mutation", "high")).toBe("deny");
    expect(observer.computeEffect("vcs", "high")).toBe("deny");
    expect(observer.computeEffect("billing", "low")).toBe("deny");
    expect(observer.computeEffect("secret", "high")).toBe("deny");
  });
});

describe("Agent Contributor computeEffect", () => {
  const contributor = specFor("Agent Contributor");

  it("allows read-like categories", () => {
    expect(contributor.computeEffect("graph", "high")).toBe("allow");
  });

  it("allows low/medium-risk mutations", () => {
    expect(contributor.computeEffect("mutation", "low")).toBe("allow");
    expect(contributor.computeEffect("mutation", "medium")).toBe("allow");
    expect(contributor.computeEffect("vcs", "medium")).toBe("allow");
  });

  it("requires approval for high-risk mutations, with no vcs/billing/secret exemption", () => {
    expect(contributor.computeEffect("mutation", "high")).toBe(
      "require_approval",
    );
    expect(contributor.computeEffect("vcs", "high")).toBe("require_approval");
    expect(contributor.computeEffect("billing", "high")).toBe(
      "require_approval",
    );
    expect(contributor.computeEffect("secret", "high")).toBe(
      "require_approval",
    );
  });
});

describe("Agent Operator computeEffect", () => {
  const operator = specFor("Agent Operator");

  it("allows read-like categories", () => {
    expect(operator.computeEffect("memory", "high")).toBe("allow");
  });

  it("allows low/medium-risk mutations", () => {
    expect(operator.computeEffect("mutation", "low")).toBe("allow");
    expect(operator.computeEffect("mutation", "medium")).toBe("allow");
  });

  it("widens high-risk mutations to allow, EXCEPT vcs/billing/secret", () => {
    expect(operator.computeEffect("mutation", "high")).toBe("allow");
    expect(operator.computeEffect("execution", "high")).toBe("allow");
  });

  it("keeps vcs/billing/secret high-risk capabilities at require_approval (spec's 'security' carve-out)", () => {
    expect(operator.computeEffect("vcs", "high")).toBe("require_approval");
    expect(operator.computeEffect("billing", "high")).toBe("require_approval");
    expect(operator.computeEffect("secret", "high")).toBe("require_approval");
  });
});

describe("makeAgentRolePublicId", () => {
  it("is deterministic and matches the rol_<sha256(orgId:scopeKind:name)[:22]> scheme shared with iam-provision.ts", () => {
    const orgId = "11111111-1111-1111-1111-111111111111";
    const expectedDigest = createHash("sha256")
      .update(`${orgId}:workspace:Agent Observer`)
      .digest("hex")
      .slice(0, 22);

    const id = makeAgentRolePublicId(orgId, "workspace", "Agent Observer");
    expect(id).toBe(`rol_${expectedDigest}`);
    // Re-running with the same inputs reproduces the same id (idempotency).
    expect(makeAgentRolePublicId(orgId, "workspace", "Agent Observer")).toBe(
      id,
    );
  });

  it("produces distinct ids for distinct roles in the same org", () => {
    const orgId = "22222222-2222-2222-2222-222222222222";
    const ids = new Set(
      AGENT_ROLE_NAMES.map((name) =>
        makeAgentRolePublicId(orgId, "workspace", name),
      ),
    );
    expect(ids.size).toBe(AGENT_ROLE_NAMES.length);
  });

  it("produces distinct ids for the same role name across distinct orgs", () => {
    const idA = makeAgentRolePublicId(
      "org-a",
      "workspace",
      "Agent Contributor",
    );
    const idB = makeAgentRolePublicId(
      "org-b",
      "workspace",
      "Agent Contributor",
    );
    expect(idA).not.toBe(idB);
  });
});

describe("makeRoleGrantPublicId", () => {
  it("is deterministic and matches the rlg_<sha256(roleId:capabilityId)[:24]> scheme", () => {
    const roleId = "33333333-3333-3333-3333-333333333333";
    const expectedDigest = createHash("sha256")
      .update(`${roleId}:graph.node.get`)
      .digest("hex")
      .slice(0, 24);

    const id = makeRoleGrantPublicId(roleId, "graph.node.get");
    expect(id).toBe(`rlg_${expectedDigest}`);
  });

  it("does not collide for capabilities sharing a name prefix (the bug this scheme fixed)", () => {
    const roleId = "44444444-4444-4444-4444-444444444444";
    const a = makeRoleGrantPublicId(roleId, "agent.background_task.start");
    const b = makeRoleGrantPublicId(roleId, "agent.background_task.read");
    const c = makeRoleGrantPublicId(roleId, "agent.background_task.cancel");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("selectAgentCapabilities", () => {
  it("excludes capabilities with no agent metadata block", () => {
    const result = selectAgentCapabilities([
      { name: "no.agent.metadata" },
      {
        name: "graph.node.get",
        agent: { category: "graph", riskLevel: "low" },
      },
    ]);
    expect(result.map((c) => c.name)).toEqual(["graph.node.get"]);
  });

  it("defaults a missing category to '' and a missing riskLevel to 'medium'", () => {
    const result = selectAgentCapabilities([
      { name: "agent.compose", agent: {} },
    ]);
    expect(result).toEqual([
      { name: "agent.compose", category: "", riskLevel: "medium" },
    ]);
  });

  it("preserves an explicit category/riskLevel", () => {
    const result = selectAgentCapabilities([
      {
        name: "secret.reveal",
        agent: { category: "secret", riskLevel: "high" },
      },
    ]);
    expect(result).toEqual([
      { name: "secret.reveal", category: "secret", riskLevel: "high" },
    ]);
  });
});
