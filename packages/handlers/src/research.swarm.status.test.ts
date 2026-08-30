import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the kernel invoke (the handler delegates to agent.subagent.aggregate).
const invoke = vi.fn();
vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import type { CapabilityContext } from "@oxagen/oxagen";
import {
  researchSwarmStatusHandler,
  mapChildrenToResults,
} from "./research.swarm.status";

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

function webSearchChild(
  query: string,
  hits: Array<{ title: string; url: string; content: string; score?: number }>,
) {
  return {
    runId: `run_${query}`,
    capabilityName: "search_web",
    status: "completed",
    summary: `${hits.length} results`,
    input: { query, maxResults: 5 },
    output: { results: hits, totalResults: hits.length, searchId: "s" },
    outputBytes: JSON.stringify(hits).length,
    errorReason: null,
  };
}

describe("mapChildrenToResults", () => {
  it("maps web.search children to per-query hits", () => {
    const results = mapChildrenToResults([
      webSearchChild("USS Nautilus crew", [
        {
          title: "Crew roster",
          url: "https://x/crew",
          content: "The crew of the Nautilus…",
          score: 0.9,
        },
      ]),
      webSearchChild("Nautilus Arctic voyage", [
        {
          title: "Under the ice",
          url: "https://x/arctic",
          content: "In 1958 the Nautilus…",
        },
      ]),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      query: "USS Nautilus crew",
      resultCount: 1,
      hits: [
        {
          title: "Crew roster",
          url: "https://x/crew",
          snippet: "The crew of the Nautilus…",
          score: 0.9,
        },
      ],
    });
    expect(results[1]?.hits[0]?.url).toBe("https://x/arctic");
  });

  it("truncates long snippets to 500 chars", () => {
    const long = "a".repeat(900);
    const [r] = mapChildrenToResults([
      webSearchChild("q", [{ title: "t", url: "https://u", content: long }]),
    ]);
    expect(r?.hits[0]?.snippet.length).toBe(500);
  });

  it("skips malformed hits and empty children", () => {
    const results = mapChildrenToResults([
      {
        runId: "r1",
        capabilityName: "search_web",
        status: "completed",
        summary: "1 result",
        input: { query: "q" },
        output: { results: [{ nope: true }] },
        outputBytes: 16,
        errorReason: null,
      },
      {
        runId: "r2",
        capabilityName: "search_web",
        status: "failed",
        summary: "failed",
        input: {},
        output: null,
        outputBytes: 0,
        errorReason: "boom",
      },
    ]);
    // First child keeps the query but yields no hits; second is fully empty → dropped.
    expect(results).toHaveLength(1);
    expect(results[0]?.hits).toEqual([]);
  });

  it("degrades to no results when children is missing instead of throwing", () => {
    // A malformed/older aggregate payload could omit `children`. Iterating
    // undefined throws "children is not iterable" and fails the whole poll.
    expect(() =>
      mapChildrenToResults(
        undefined as unknown as Parameters<typeof mapChildrenToResults>[0],
      ),
    ).not.toThrow();
    expect(
      mapChildrenToResults(
        undefined as unknown as Parameters<typeof mapChildrenToResults>[0],
      ),
    ).toEqual([]);
  });
});

describe("researchSwarmStatusHandler", () => {
  afterEach(() => invoke.mockReset());

  it("resolves the swarm by passing swarmId straight through as the fanoutId", async () => {
    // No in-process store: the swarmId IS the fanout public_id, so it is handed
    // directly to agent.subagent.aggregate (which resolves it from Postgres).
    invoke.mockResolvedValue({
      fanoutId: "fan_1",
      status: "completed",
      totalChildren: 2,
      completedChildren: 2,
      aggregatedData: {},
      conflicts: [],
      timeline: [],
      children: [
        webSearchChild("USS Nautilus", [
          {
            title: "Nautilus",
            url: "https://x",
            content: "first nuclear sub",
            score: 1,
          },
        ]),
      ],
      firstError: null,
    });

    const out = await researchSwarmStatusHandler({ swarmId: "fan_1" }, ctx);
    expect(invoke).toHaveBeenCalledWith(
      "aggregate_subagents",
      expect.objectContaining({ fanoutId: "fan_1" }),
      ctx,
    );
    expect(out.status).toBe("complete");
    expect(out.swarmId).toBe("fan_1");
    expect(out.dispatchId).toBe("fan_1");
    expect(out.completedTasks).toBe(2);
    expect(out.results).toBeDefined();
    expect(out.results?.[0]?.hits[0]?.title).toBe("Nautilus");
  });

  it("omits results while the swarm is still running with no output", async () => {
    invoke.mockResolvedValue({
      fanoutId: "fan_2",
      status: "running",
      totalChildren: 3,
      completedChildren: 0,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      firstError: null,
    });

    const out = await researchSwarmStatusHandler({ swarmId: "fan_2" }, ctx);
    expect(out.status).toBe("running");
    expect(out.results).toBeUndefined();
  });

  it("does NOT force a zero staleness window on aggregate (running ≠ timed_out)", async () => {
    // Regression: passing timeoutMs:0 made deriveAggregateStatus treat any
    // in-flight fanout as timed_out (age 0 >= 0) → mapped to "failed", so a
    // running swarm never showed progress. The status poll must let the
    // aggregate use its default staleness window.
    invoke.mockResolvedValue({
      fanoutId: "fan_3",
      status: "running",
      totalChildren: 5,
      completedChildren: 2,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      firstError: null,
    });

    await researchSwarmStatusHandler({ swarmId: "fan_3" }, ctx);

    expect(invoke).toHaveBeenCalledWith(
      "aggregate_subagents",
      expect.objectContaining({ fanoutId: "fan_3" }),
      ctx,
    );
    const [, aggregateInput] = invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
      unknown,
    ];
    expect(aggregateInput.timeoutMs).toBeUndefined();
  });

  it("propagates the aggregate's not-found error for an unknown fanout", async () => {
    // Tenant isolation + unknown-id handling now live in agent.subagent.aggregate
    // (Postgres lookup scoped by org+workspace), so its error surfaces verbatim.
    // The ROUTE (research.swarm.status.ts in apps/api) catches this error and
    // maps it to HTTP 404 — the handler itself must not swallow it (the route
    // needs the message to decide the right status code).
    invoke.mockRejectedValue(new Error("Fanout nope not found"));
    await expect(
      researchSwarmStatusHandler({ swarmId: "nope" }, ctx),
    ).rejects.toThrow(/not found/);
  });

  it("returns terminal 'failed' for an orphaned/timed-out swarm (never 500)", async () => {
    // Regression: a swarm started days ago is past the 5-min aggregate staleness
    // window → aggregate reports status:'timed_out' → mapStatus maps to 'failed'.
    // The handler must return a clean terminal payload, never throw.
    invoke.mockResolvedValue({
      fanoutId: "fan_old",
      status: "timed_out",
      totalChildren: 3,
      completedChildren: 0,
      aggregatedData: null,
      conflicts: [],
      timeline: [],
      children: [],
      firstError: null,
    });

    const out = await researchSwarmStatusHandler({ swarmId: "fan_old" }, ctx);
    expect(out.status).toBe("failed");
    expect(out.completedTasks).toBe(0);
    expect(out.totalTasks).toBe(3);
    expect(out.results).toBeUndefined();
  });

  it("returns terminal 'complete' for a partial fanout (some succeeded, some failed)", async () => {
    // Aggregate 'partial' (some children completed, some failed) maps to 'complete'
    // so the agent can still summarise the successful queries instead of hiding them.
    invoke.mockResolvedValue({
      fanoutId: "fan_partial",
      status: "partial",
      totalChildren: 3,
      completedChildren: 2,
      aggregatedData: {},
      conflicts: [],
      timeline: [],
      children: [
        webSearchChild("success query", [
          { title: "T", url: "https://x", content: "snippet" },
        ]),
      ],
      firstError: "one child failed",
    });

    const out = await researchSwarmStatusHandler(
      { swarmId: "fan_partial" },
      ctx,
    );
    expect(out.status).toBe("complete");
    expect(out.completedTasks).toBe(2);
    expect(out.results).toBeDefined();
  });
});
