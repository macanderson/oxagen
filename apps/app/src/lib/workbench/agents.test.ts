/**
 * agents.test.ts — unit tests for the workbench/agents.ts kernel wrappers.
 *
 * Mock seam: @oxagen/oxagen → invoke. Every export here is a thin, typed
 * pass-through to invoke() with a fixed capability name — verify the correct
 * capability + args + ctx + surface are used and the (mocked) output is
 * returned as-is, plus isCodingAgent's two accepted spellings.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@oxagen/oxagen";
import {
  isCodingAgent,
  listAgents,
  getAgent,
  suggestAgentDefinition,
  createAgent,
  updateAgent,
  publishAgent,
  deployAgent,
  CODING_AGENT_TYPE,
  DEFAULT_AGENT_TYPE,
} from "./agents";
import type { WorkbenchCtx } from "./scope";

const mockInvoke = vi.mocked(invoke);

const ctx: WorkbenchCtx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

describe("isCodingAgent", () => {
  it('accepts the platform convention "code"', () => {
    expect(isCodingAgent(CODING_AGENT_TYPE)).toBe(true);
  });
  it('stays read-tolerant of the earlier "coding" spelling', () => {
    expect(isCodingAgent("coding")).toBe(true);
  });
  it("returns false for the default conversational type", () => {
    expect(isCodingAgent(DEFAULT_AGENT_TYPE)).toBe(false);
  });
});

describe("workbench/agents.ts kernel wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listAgents calls list_agent_defs and unwraps { agents }", async () => {
    const agents = [{ agentId: "a1" }];
    mockInvoke.mockResolvedValue({ agents });

    const result = await listAgents(ctx, "active");

    expect(mockInvoke).toHaveBeenCalledWith(
      "list_agent_defs",
      { status: "active" },
      ctx,
      { surface: "agent" },
    );
    expect(result).toBe(agents);
  });

  it("getAgent calls get_agent_def with the agentId", async () => {
    const detail = { agentId: "a1", name: "Agent One" };
    mockInvoke.mockResolvedValue(detail);

    const result = await getAgent(ctx, "a1");

    expect(mockInvoke).toHaveBeenCalledWith(
      "get_agent_def",
      { agentId: "a1" },
      ctx,
      { surface: "agent" },
    );
    expect(result).toBe(detail);
  });

  it("suggestAgentDefinition passes the input through unchanged", async () => {
    const input = { description: "A research agent", nameHint: "Researcher" };
    const suggestion = {
      suggestion: {},
      rationale: "r",
      warnings: [],
      recommendations: [],
    };
    mockInvoke.mockResolvedValue(suggestion);

    const result = await suggestAgentDefinition(ctx, input);

    expect(mockInvoke).toHaveBeenCalledWith("suggest_agent_def", input, ctx, {
      surface: "agent",
    });
    expect(result).toBe(suggestion);
  });

  it("createAgent defaults agentType to DEFAULT_AGENT_TYPE when omitted", async () => {
    const created = { agentId: "a1", publicId: "pub", slug: "s", version: 1 };
    mockInvoke.mockResolvedValue(created);

    const result = await createAgent(ctx, {
      slug: "s",
      name: "Agent",
      config: {} as never,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "create_agent_def",
      {
        slug: "s",
        name: "Agent",
        description: undefined,
        agentType: DEFAULT_AGENT_TYPE,
        config: {},
      },
      ctx,
      { surface: "agent" },
    );
    expect(result).toBe(created);
  });

  it("createAgent passes through an explicit agentType", async () => {
    mockInvoke.mockResolvedValue({
      agentId: "a1",
      publicId: "pub",
      slug: "s",
      version: 1,
    });

    await createAgent(ctx, {
      slug: "s",
      name: "Agent",
      description: "desc",
      agentType: CODING_AGENT_TYPE,
      config: {} as never,
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "create_agent_def",
      {
        slug: "s",
        name: "Agent",
        description: "desc",
        agentType: CODING_AGENT_TYPE,
        config: {},
      },
      ctx,
      { surface: "agent" },
    );
  });

  it("updateAgent forwards the whole input object", async () => {
    const updated = { agentId: "a1", version: 2, isPublished: false };
    mockInvoke.mockResolvedValue(updated);
    const input = { agentId: "a1", name: "New name", config: {} as never };

    const result = await updateAgent(ctx, input);

    expect(mockInvoke).toHaveBeenCalledWith("update_agent_def", input, ctx, {
      surface: "agent",
    });
    expect(result).toBe(updated);
  });

  it("publishAgent calls publish_agent_def with agentId + optional version", async () => {
    const published = { agentId: "a1", version: 3, checksum: "abc" };
    mockInvoke.mockResolvedValue(published);

    const result = await publishAgent(ctx, "a1", 3);

    expect(mockInvoke).toHaveBeenCalledWith(
      "publish_agent_def",
      { agentId: "a1", version: 3 },
      ctx,
      { surface: "agent" },
    );
    expect(result).toBe(published);
  });

  it("deployAgent calls deploy_agent with agentId + deploymentStatus", async () => {
    const deployed = { agentId: "a1", deploymentStatus: "active" as const };
    mockInvoke.mockResolvedValue(deployed);

    const result = await deployAgent(ctx, "a1", "active");

    expect(mockInvoke).toHaveBeenCalledWith(
      "deploy_agent",
      { agentId: "a1", deploymentStatus: "active" },
      ctx,
      { surface: "agent" },
    );
    expect(result).toBe(deployed);
  });
});
