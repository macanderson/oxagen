import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  invoke: vi.fn(),
}));

mocks.generateObjectFor.mockResolvedValue({
  object: {
    queries: ["search query 1", "search query 2", "search query 3"],
  },
  usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
});

mocks.invoke.mockResolvedValue({
  dispatchId: "fanout_abc",
  totalTasks: 3,
  status: "pending",
});

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
}));

import { researchSwarmStartHandler } from "./research.swarm.start";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

describe("researchSwarmStartHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        queries: ["search query 1", "search query 2", "search query 3"],
      },
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
    mocks.invoke.mockResolvedValue({
      dispatchId: "fanout_abc",
      totalTasks: 3,
      status: "pending",
    });
  });

  it("generates queries and dispatches subagent tasks", async () => {
    const result = await researchSwarmStartHandler(
      {
        topic: "TypeScript monorepo best practices",
        depth: "shallow",
        maxParallel: 5,
        targetLabel: "Topic",
        searchDepth: "basic",
      },
      CTX,
    );

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    const genCall = mocks.generateObjectFor.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(typeof genCall.prompt).toBe("string");
    expect(String(genCall.prompt)).toContain(
      "TypeScript monorepo best practices",
    );
    expect(String(genCall.prompt)).toContain("3"); // shallow = 3 queries

    expect(mocks.invoke).toHaveBeenCalledWith(
      "dispatch_subagent",
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({ capabilityName: "search_web" }),
        ]),
      }),
      CTX,
    );

    expect(result.status).toBe("running");
    expect(result.dispatchId).toBe("fanout_abc");
    expect(typeof result.swarmId).toBe("string");
    expect(result.estimatedTasks).toBe(3);
  });

  it("uses the durable fanout public_id as the swarmId (no in-process store)", async () => {
    // The swarmId must equal the dispatchId so any process (apps/api polling)
    // can resolve the swarm via agent.subagent.aggregate against Postgres —
    // no shared in-memory map, which broke cross-process status polling.
    const result = await researchSwarmStartHandler(
      {
        topic: "test topic",
        depth: "shallow",
        maxParallel: 3,
        targetLabel: "Topic",
        searchDepth: "basic",
      },
      CTX,
    );

    expect(result.swarmId).toBe("fanout_abc");
    expect(result.swarmId).toBe(result.dispatchId);
  });

  it("respects depth=medium → 8 queries in the prompt", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        queries: Array.from({ length: 8 }, (_, i) => `query ${i + 1}`),
      },
      usage: { promptTokens: 20, completionTokens: 40, totalTokens: 60 },
    });
    mocks.invoke.mockResolvedValue({
      dispatchId: "fanout_medium",
      totalTasks: 8,
      status: "pending",
    });

    const result = await researchSwarmStartHandler(
      {
        topic: "AI agent memory systems",
        depth: "medium",
        maxParallel: 5,
        targetLabel: "Topic",
        searchDepth: "advanced",
      },
      CTX,
    );

    const genCall = mocks.generateObjectFor.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(String(genCall.prompt)).toContain("8");
    expect(result.estimatedTasks).toBe(8);
  });

  it("caps queries at the depth count even if model returns more", async () => {
    // Model returns 15 queries but depth=shallow only wants 3
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        queries: Array.from({ length: 15 }, (_, i) => `extra query ${i + 1}`),
      },
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
    mocks.invoke.mockResolvedValue({
      dispatchId: "fanout_capped",
      totalTasks: 3,
      status: "pending",
    });

    const result = await researchSwarmStartHandler(
      {
        topic: "quantum computing",
        depth: "shallow",
        maxParallel: 5,
        targetLabel: "Topic",
        searchDepth: "basic",
      },
      CTX,
    );

    const invokeCall = mocks.invoke.mock.calls[0]?.[1] as { tasks: unknown[] };
    expect(invokeCall.tasks).toHaveLength(3);
    expect(result.estimatedTasks).toBe(3);
  });
});
