import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Mock the kernel so graph.stats is a controllable nested invoke ────────────
// We capture every invoke() call to assert the SURFACE the recommend handler
// hands graph.stats (the bug: it passed ctx.surface "app", which graph.stats's
// contract — surfaces ["api","mcp","agent"] — rejects, silently degrading to a
// generic proposal).
const invokeCalls: Array<{ name: string; surface: unknown }> = [];
let graphStatsImpl: () => Promise<unknown> = async () => ({});
vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: async (
    name: string,
    _input: unknown,
    _ctx: unknown,
    opts?: { surface?: unknown },
  ) => {
    invokeCalls.push({ name, surface: opts?.surface });
    if (name === "get_graph_stats") return graphStatsImpl();
    return {};
  },
}));

// ── Mock the LLM layer; capture the prompt the handler builds from graph stats ─
let capturedPrompt = "";
const mockGenerateObjectFor = vi.fn(async (args: { prompt: string }) => {
  capturedPrompt = args.prompt;
  return {
    object: {
      schemas: [
        {
          name: "code",
          displayName: "Code",
          labels: [],
          relationshipTypes: [],
        },
      ],
    },
  };
});
vi.mock("@oxagen/ai", () => ({
  generateObjectFor: (...args: unknown[]) =>
    mockGenerateObjectFor(args[0] as { prompt: string }),
  selectModel: () => "mock-model",
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaRecommendHandler } from "./schema.recommend";

// A seeded source-code-ingestion graph (the demo fixture): graph.stats reports
// these as nodesByLabel / edgeCount — the exact fields the handler must read.
const SOURCE_CODE_STATS = {
  nodeCount: 85,
  edgeCount: 71,
  inferredEdgeCount: 25,
  sourceCount: 1,
  nodesByLabel: {
    Function: 28,
    Commit: 24,
    File: 14,
    Class: 10,
    Module: 5,
    Author: 3,
    Repository: 1,
  },
  edgesByType: {
    CONTAINS: 19,
    DEFINES: 38,
    CALLS: 25,
    HAS_METHOD: 10,
    AUTHORED: 24,
  },
};

const ctx = (surface: CapabilityContext["surface"]): CapabilityContext => ({
  orgId: "9f71d7f8-2d9f-48aa-9117-8ce6f2df60ae",
  workspaceId: "6c7cf857-c073-47be-b625-ffcac9551884",
  userId: "u1",
  apiKeyId: null,
  requestId: "req_recommend",
  surface,
  messageId: "msg_1",
});

beforeEach(() => {
  invokeCalls.length = 0;
  capturedPrompt = "";
  graphStatsImpl = async () => SOURCE_CODE_STATS;
  mockGenerateObjectFor.mockClear();
});

describe("schema.recommend — graph.stats signal mapping", () => {
  it("invokes graph.stats over a contract surface, never the in-app caller surface", async () => {
    // The bug passed ctx.surface ("app"), which graph.stats's contract
    // (api/mcp/agent) rejects → swallowed → graph-blind proposal.
    await schemaRecommendHandler({ sampleLimit: 200 }, ctx("app"));
    const statsCall = invokeCalls.find((c) => c.name === "get_graph_stats");
    expect(statsCall).toBeDefined();
    expect(statsCall?.surface).toBe("api");
    expect(statsCall?.surface).not.toBe("app");
  });

  it("never leaks a surface graph.stats can't accept (e.g. 'runner')", async () => {
    // "runner" is a valid ctx surface but NOT a graph.stats contract surface;
    // the internal read must still resolve over "api".
    await schemaRecommendHandler({ sampleLimit: 200 }, ctx("runner"));
    expect(invokeCalls.find((c) => c.name === "get_graph_stats")?.surface).toBe(
      "api",
    );
  });

  it("feeds the real node count + observed labels into the LLM prompt", async () => {
    await schemaRecommendHandler({ sampleLimit: 200 }, ctx("app"));
    // Reads nodesByLabel (not the old, absent `byType`) and edgeCount (not the
    // old, absent `relationshipCount`).
    expect(capturedPrompt).toContain("Total nodes: 85");
    expect(capturedPrompt).toContain("Total relationships: 71");
    // Labels sorted by frequency, descending.
    expect(capturedPrompt).toContain("Function: 28");
    expect(capturedPrompt).toContain("Repository: 1");
    expect(capturedPrompt).not.toContain("no type data available");
    const fnIdx = capturedPrompt.indexOf("Function: 28");
    const repoIdx = capturedPrompt.indexOf("Repository: 1");
    expect(fnIdx).toBeLessThan(repoIdx);
  });

  it("reports the analyzed graph in the rationale + sampledCount", async () => {
    const result = await schemaRecommendHandler(
      { sampleLimit: 200 },
      ctx("app"),
    );
    expect(result.rationale).toContain(
      "Analyzed 85 nodes and 71 relationships",
    );
    expect(result.rationale).toContain("Function: 28");
    expect(result.sampledCount).toBe(85);
    expect(result.proposal.schemas).toHaveLength(1);
  });

  it("degrades gracefully when graph.stats is unavailable (empty graph signal)", async () => {
    graphStatsImpl = async () => {
      throw new Error("graph.stats exploded");
    };
    const result = await schemaRecommendHandler(
      { sampleLimit: 200 },
      ctx("app"),
    );
    // Still produces a proposal — just with no graph signal.
    expect(capturedPrompt).toContain("Total nodes: 0");
    expect(capturedPrompt).toContain("no type data available");
    expect(result.rationale).toContain("Analyzed 0 nodes");
    expect(result.sampledCount).toBe(0);
  });

  it("treats an empty nodesByLabel as no type data (no false label list)", async () => {
    graphStatsImpl = async () => ({
      nodeCount: 0,
      edgeCount: 0,
      nodesByLabel: {},
    });
    await schemaRecommendHandler({ sampleLimit: 200 }, ctx("app"));
    expect(capturedPrompt).toContain("no type data available");
  });
});
