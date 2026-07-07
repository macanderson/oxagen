import { describe, expect, it, vi, beforeEach } from "vitest";

// Heavy server deps are mocked so the action's pure validation + IAM-gate logic
// can be exercised in isolation (no DB, no Next cache, no kernel registration).
// vi.mock is hoisted above all declarations, so the mock fns it references must
// be created with vi.hoisted() (a plain top-level const would be uninitialized
// at mock time — "Cannot access before initialization").
const {
  resolveStudioScope,
  createAgent,
  updateAgent,
  publishAgent,
  deployAgent,
  suggestAgentDefinition,
} = vi.hoisted(() => ({
  resolveStudioScope: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  publishAgent: vi.fn(),
  deployAgent: vi.fn(),
  suggestAgentDefinition: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/studio/scope", () => ({ resolveStudioScope }));
vi.mock("@/lib/studio/agents", () => ({
  createAgent,
  updateAgent,
  publishAgent,
  deployAgent,
  suggestAgentDefinition,
}));

import {
  createAgentAction,
  updateAgentAction,
  deployAgentAction,
  suggestAgentAction,
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
  resolveStudioScope.mockResolvedValue({ ctx: CTX, canManage: true });
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
    expect(resolveStudioScope).not.toHaveBeenCalled();
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
    resolveStudioScope.mockResolvedValue({ ctx: CTX, canManage: false });
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
    resolveStudioScope.mockResolvedValue({ ctx: CTX, canManage: false });
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
    expect(resolveStudioScope).not.toHaveBeenCalled();
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
    resolveStudioScope.mockResolvedValue({ ctx: CTX, canManage: false });
    const res = await suggestAgentAction({
      ...SCOPE,
      description: "A perfectly valid, sufficiently long description.",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/owners and admins/i);
    expect(suggestAgentDefinition).not.toHaveBeenCalled();
  });

  it("returns the suggestion, rationale and warnings for a manager", async () => {
    suggestAgentDefinition.mockResolvedValue({
      suggestion: SUGGESTION,
      rationale: "Manual trigger keeps it human-in-the-loop.",
      warnings: ["dropped an unknown tool ref"],
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
    }
    // description flows through to the helper.
    expect(suggestAgentDefinition).toHaveBeenCalledWith(
      CTX,
      expect.objectContaining({
        description: "A release-notes writer grounded in the engineering ontology.",
      }),
    );
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
