import { describe, expect, it, vi, beforeEach } from "vitest";

// Heavy server deps are mocked so the action's pure validation + IAM-gate logic
// can be exercised in isolation (no DB, no Next cache, no kernel registration).
// vi.mock is hoisted above all declarations, so the mock fns it references must
// be created with vi.hoisted() (a plain top-level const would be uninitialized
// at mock time — "Cannot access before initialization").
const {
  resolveWorkbenchScope,
  createAgent,
  updateAgent,
  publishAgent,
  deployAgent,
  suggestAgentDefinition,
  assignAgentRole,
  revokeAgentRole,
} = vi.hoisted(() => ({
  resolveWorkbenchScope: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  publishAgent: vi.fn(),
  deployAgent: vi.fn(),
  suggestAgentDefinition: vi.fn(),
  assignAgentRole: vi.fn(),
  revokeAgentRole: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workbench/scope", () => ({ resolveWorkbenchScope }));
vi.mock("@/lib/workbench/agents", () => ({
  createAgent,
  updateAgent,
  publishAgent,
  deployAgent,
  suggestAgentDefinition,
}));
vi.mock("@/lib/workbench/agent-roles", () => ({
  assignAgentRole,
  revokeAgentRole,
  // Same narrowing the real module ships (kept trivial so the action's
  // error-code passthrough is exercised for real).
  isCeilingError: (err: unknown) =>
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "agent_role_ceiling_exceeded" &&
    Array.isArray((err as { capabilities?: unknown }).capabilities),
}));

import {
  createAgentAction,
  updateAgentAction,
  deployAgentAction,
  suggestAgentAction,
  assignAgentRoleAction,
} from "./actions";

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };
const CTX = { orgId: "o1", workspaceId: "w1", userId: "u1" };
const GRAPH = {
  ontologyId: "ont_1",
  mode: "read" as const,
  retrieval: { strategy: "hybrid" as const },
  budget: { maxHops: 2, maxNodes: 40 },
};
const CONFIG = { graph: GRAPH, agentTools: [], triggers: [] };

beforeEach(() => {
  vi.clearAllMocks();
  resolveWorkbenchScope.mockResolvedValue({ ctx: CTX, canManage: true });
});

describe("createAgentAction", () => {
  it("rejects a non-kebab slug before touching scope", async () => {
    const res = await createAgentAction({
      ...SCOPE,
      slug: "Not Kebab",
      name: "X",
      agentType: "custom",
      config: CONFIG,
    });
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
  });

  it("rejects an empty name", async () => {
    const res = await createAgentAction({
      ...SCOPE,
      slug: "ok-slug",
      name: "",
      agentType: "custom",
      config: CONFIG,
    });
    expect(res.ok).toBe(false);
  });

  it("denies a non-manager", async () => {
    resolveWorkbenchScope.mockResolvedValue({ ctx: CTX, canManage: false });
    const res = await createAgentAction({
      ...SCOPE,
      slug: "ok-slug",
      name: "Agent",
      agentType: "coding",
      config: CONFIG,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/owners and admins/i);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("creates and returns the public id for a manager", async () => {
    createAgent.mockResolvedValue({
      agentId: "uuid",
      publicId: "agt_1",
      slug: "ok-slug",
      version: 1,
    });
    const res = await createAgentAction({
      ...SCOPE,
      slug: "ok-slug",
      name: "Agent",
      agentType: "coding",
      config: CONFIG,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.publicId).toBe("agt_1");
      expect(res.agentId).toBe("agt_1");
    }
    // agentType flows through to the helper (code-features persistence).
    expect(createAgent).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ agentType: "coding" }),
    );
  });

  it("surfaces a helper failure as { ok: false }", async () => {
    createAgent.mockRejectedValue(new Error("slug already exists"));
    const res = await createAgentAction({
      ...SCOPE,
      slug: "ok-slug",
      name: "Agent",
      agentType: "custom",
      config: CONFIG,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already exists/);
  });
});

describe("updateAgentAction", () => {
  it("passes an agentType change through to updateAgent", async () => {
    updateAgent.mockResolvedValue({ agentId: "agt_1", version: 2, isPublished: false });
    const res = await updateAgentAction({
      ...SCOPE,
      agentId: "agt_1",
      name: "Agent",
      agentType: "custom",
      config: CONFIG,
    });
    expect(res.ok).toBe(true);
    expect(updateAgent).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({ agentId: "agt_1", agentType: "custom" }),
    );
  });

  it("denies a non-manager", async () => {
    resolveWorkbenchScope.mockResolvedValue({ ctx: CTX, canManage: false });
    const res = await updateAgentAction({
      ...SCOPE,
      agentId: "agt_1",
      config: CONFIG,
    });
    expect(res.ok).toBe(false);
    expect(updateAgent).not.toHaveBeenCalled();
  });
});

describe("suggestAgentAction", () => {
  const SUGGESTION = {
    slug: "release-notes-writer",
    name: "Release Notes Writer",
    description: "Drafts changelogs from merged PRs.",
    agentType: "custom",
    config: {
      graph: GRAPH,
      agentTools: [],
      triggers: [{ type: "manual" as const, enabled: true }],
      instructions: "You draft release notes.",
    },
  };

  it("rejects a too-short description before touching scope", async () => {
    const res = await suggestAgentAction({
      ...SCOPE,
      description: "too short",
    });
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
    expect(suggestAgentDefinition).not.toHaveBeenCalled();
  });

  it("rejects a non-kebab nameHint", async () => {
    const res = await suggestAgentAction({
      ...SCOPE,
      description: "A perfectly valid, sufficiently long description.",
      nameHint: "Not Kebab",
    });
    expect(res.ok).toBe(false);
    expect(suggestAgentDefinition).not.toHaveBeenCalled();
  });

  it("denies a non-manager", async () => {
    resolveWorkbenchScope.mockResolvedValue({ ctx: CTX, canManage: false });
    const res = await suggestAgentAction({
      ...SCOPE,
      description: "A perfectly valid, sufficiently long description.",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/owners and admins/i);
    expect(suggestAgentDefinition).not.toHaveBeenCalled();
  });

  const RECOMMENDATIONS = [
    {
      kind: "mcp_server" as const,
      ref: "github/github-mcp-server",
      name: "GitHub",
      reason: "Watches merged PRs — needs GitHub access.",
    },
    {
      kind: "skill" as const,
      ref: "changelog-formatter",
      name: "Changelog Formatter",
      reason: "Formats the drafted notes; currently disabled.",
    },
  ];

  it("returns the suggestion, rationale, warnings and recommendations for a manager", async () => {
    suggestAgentDefinition.mockResolvedValue({
      suggestion: SUGGESTION,
      rationale: "Manual trigger keeps it human-in-the-loop.",
      warnings: ["dropped an unknown tool ref"],
      recommendations: RECOMMENDATIONS,
    });
    const res = await suggestAgentAction({
      ...SCOPE,
      description: "A release-notes writer grounded in the engineering ontology.",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.suggestion.slug).toBe("release-notes-writer");
      expect(res.rationale).toMatch(/human-in-the-loop/);
      expect(res.warnings).toEqual(["dropped an unknown tool ref"]);
      // Catalog recommendations pass straight through — never merged into
      // suggestion.config.agentTools (which only carries available refs).
      expect(res.recommendations).toEqual(RECOMMENDATIONS);
      expect(res.suggestion.config.agentTools).toEqual([]);
    }
    // description flows through to the helper.
    expect(suggestAgentDefinition).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        description: "A release-notes writer grounded in the engineering ontology.",
      }),
    );
  });

  it("passes an empty recommendations list straight through", async () => {
    suggestAgentDefinition.mockResolvedValue({
      suggestion: SUGGESTION,
      rationale: "No extra connections needed.",
      warnings: [],
      recommendations: [],
    });
    const res = await suggestAgentAction({
      ...SCOPE,
      description: "A perfectly valid, sufficiently long description.",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.recommendations).toEqual([]);
  });

  it("surfaces a helper failure as { ok: false }", async () => {
    suggestAgentDefinition.mockRejectedValue(new Error("model unavailable"));
    const res = await suggestAgentAction({
      ...SCOPE,
      description: "A perfectly valid, sufficiently long description.",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/model unavailable/);
  });
});

describe("deployAgentAction", () => {
  it("rejects an invalid deploymentStatus", async () => {
    const res = await deployAgentAction({
      ...SCOPE,
      agentId: "agt_1",
      // @ts-expect-error — exercising the zod guard against a bad status.
      deploymentStatus: "live",
    });
    expect(res.ok).toBe(false);
    expect(deployAgent).not.toHaveBeenCalled();
  });

  it("deploys active for a manager", async () => {
    deployAgent.mockResolvedValue({ agentId: "agt_1", deploymentStatus: "active" });
    const res = await deployAgentAction({
      ...SCOPE,
      agentId: "agt_1",
      deploymentStatus: "active",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.deploymentStatus).toBe("active");
  });
});

describe("assignAgentRoleAction", () => {
  it("denies a non-manager without touching the contracts", async () => {
    resolveWorkbenchScope.mockResolvedValue({ ctx: CTX, canManage: false });
    const res = await assignAgentRoleAction({
      ...SCOPE,
      agentId: "agt_1",
      roleName: "Agent Operator",
    });
    expect(res.ok).toBe(false);
    expect(assignAgentRole).not.toHaveBeenCalled();
    expect(revokeAgentRole).not.toHaveBeenCalled();
  });

  it("assigns, then revokes the previous role only after the assign landed", async () => {
    assignAgentRole.mockResolvedValue({
      assigned: true,
      alreadyAssigned: false,
      agentId: "agt_1",
      roleId: "rol_1",
      roleName: "Agent Operator",
    });
    revokeAgentRole.mockResolvedValue({
      revoked: true,
      agentId: "agt_1",
      roleName: "Agent Contributor",
    });

    const res = await assignAgentRoleAction({
      ...SCOPE,
      agentId: "agt_1",
      roleName: "Agent Operator",
      previousRoleName: "Agent Contributor",
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.roleName).toBe("Agent Operator");
    expect(assignAgentRole).toHaveBeenCalledWith(CTX, "agt_1", "Agent Operator");
    expect(revokeAgentRole).toHaveBeenCalledWith(
      CTX,
      "agt_1",
      "Agent Contributor",
    );
    // Ordering: a rejected assign must leave the old role intact.
    expect(assignAgentRole.mock.invocationCallOrder[0]!).toBeLessThan(
      revokeAgentRole.mock.invocationCallOrder[0]!,
    );
  });

  it("skips the revoke when the selection matches the previous role", async () => {
    assignAgentRole.mockResolvedValue({
      assigned: true,
      alreadyAssigned: true,
      agentId: "agt_1",
      roleId: "rol_1",
      roleName: "Agent Contributor",
    });
    const res = await assignAgentRoleAction({
      ...SCOPE,
      agentId: "agt_1",
      roleName: "Agent Contributor",
      previousRoleName: "Agent Contributor",
    });
    expect(res.ok).toBe(true);
    expect(revokeAgentRole).not.toHaveBeenCalled();
  });

  it("surfaces the delegation-ceiling rejection with its stable code and capabilities, without revoking", async () => {
    assignAgentRole.mockRejectedValue(
      Object.assign(new Error("Role 'Agent Operator' grants capabilities beyond your own effective access"), {
        code: "agent_role_ceiling_exceeded",
        capabilities: ["secret.reveal", "repo.pr.open"],
      }),
    );

    const res = await assignAgentRoleAction({
      ...SCOPE,
      agentId: "agt_1",
      roleName: "Agent Operator",
      previousRoleName: "Agent Contributor",
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("agent_role_ceiling_exceeded");
      expect(res.capabilities).toEqual(["secret.reveal", "repo.pr.open"]);
      expect(res.error).toMatch(/beyond your own effective access/);
    }
    expect(revokeAgentRole).not.toHaveBeenCalled();
  });

  it("passes through other typed error codes (e.g. tier gate) verbatim", async () => {
    assignAgentRole.mockRejectedValue(
      Object.assign(new Error("custom agent roles require enterprise"), {
        code: "tier_denied",
      }),
    );
    const res = await assignAgentRoleAction({
      ...SCOPE,
      agentId: "agt_1",
      roleName: "Release Ops",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("tier_denied");
  });
});
