import { describe, expect, it, vi, beforeEach } from "vitest";

// Heavy server deps are mocked so the action's pure validation + IAM-gate logic
// can be exercised in isolation (no DB, no Next cache, no kernel registration).
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const resolveStudioScope = vi.fn();
vi.mock("@/lib/studio/scope", () => ({ resolveStudioScope }));

const createAgent = vi.fn();
const updateAgent = vi.fn();
const publishAgent = vi.fn();
const deployAgent = vi.fn();
vi.mock("@/lib/studio/agents", () => ({
  createAgent,
  updateAgent,
  publishAgent,
  deployAgent,
}));

import {
  createAgentAction,
  updateAgentAction,
  deployAgentAction,
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
