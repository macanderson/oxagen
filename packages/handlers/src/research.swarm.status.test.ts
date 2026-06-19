import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the kernel invoke (the handler delegates to agent.subagent.aggregate).
const invoke = vi.fn();
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import type { CapabilityContext } from "@oxagen/oxagen";
import { researchSwarmStatusHandler, mapChildrenToResults } from "./research.swarm.status";
import { storeSwarm } from "./research.swarm.store";

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

function webSearchChild(query: string, hits: Array<{ title: string; url: string; content: string; score?: number }>) {
  return {
    runId: `run_${query}`,
    capabilityName: "web.search",
    status: "completed",
    input: { query, maxResults: 5 },
    output: { results: hits, totalResults: hits.length, searchId: "s" },
    errorReason: null,
  };
}

describe("mapChildrenToResults", () => {
  it("maps web.search children to per-query hits", () => {
    const results = mapChildrenToResults([
      webSearchChild("USS Nautilus crew", [
        { title: "Crew roster", url: "https://x/crew", content: "The crew of the Nautilus…", score: 0.9 },
      ]),
      webSearchChild("Nautilus Arctic voyage", [
        { title: "Under the ice", url: "https://x/arctic", content: "In 1958 the Nautilus…" },
      ]),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      query: "USS Nautilus crew",
      resultCount: 1,
      hits: [{ title: "Crew roster", url: "https://x/crew", snippet: "The crew of the Nautilus…", score: 0.9 }],
    });
    expect(results[1]?.hits[0]?.url).toBe("https://x/arctic");
  });

  it("truncates long snippets to 500 chars", () => {
    const long = "a".repeat(900);
    const [r] = mapChildrenToResults([webSearchChild("q", [{ title: "t", url: "https://u", content: long }])]);
    expect(r?.hits[0]?.snippet.length).toBe(500);
  });

  it("skips malformed hits and empty children", () => {
    const results = mapChildrenToResults([
      { runId: "r1", capabilityName: "web.search", status: "completed", input: { query: "q" }, output: { results: [{ nope: true }] }, errorReason: null },
      { runId: "r2", capabilityName: "web.search", status: "failed", input: {}, output: null, errorReason: "boom" },
    ]);
    // First child keeps the query but yields no hits; second is fully empty → dropped.
    expect(results).toHaveLength(1);
    expect(results[0]?.hits).toEqual([]);
  });
});

describe("researchSwarmStatusHandler", () => {
  afterEach(() => invoke.mockReset());

  it("returns the aggregated hits once the swarm produces output", async () => {
    storeSwarm("swm_status_1", { dispatchId: "fan_1", totalTasks: 2, orgId: "org-1", workspaceId: "ws-1" });
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
          { title: "Nautilus", url: "https://x", content: "first nuclear sub", score: 1 },
        ]),
      ],
      firstError: null,
    });

    const out = await researchSwarmStatusHandler({ swarmId: "swm_status_1" }, ctx);
    expect(out.status).toBe("complete");
    expect(out.completedTasks).toBe(2);
    expect(out.results).toBeDefined();
    expect(out.results?.[0]?.hits[0]?.title).toBe("Nautilus");
  });

  it("omits results while the swarm is still running with no output", async () => {
    storeSwarm("swm_status_2", { dispatchId: "fan_2", totalTasks: 3, orgId: "org-1", workspaceId: "ws-1" });
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

    const out = await researchSwarmStatusHandler({ swarmId: "swm_status_2" }, ctx);
    expect(out.status).toBe("running");
    expect(out.results).toBeUndefined();
  });

  it("throws when the swarm id is unknown to this tenant", async () => {
    await expect(researchSwarmStatusHandler({ swarmId: "nope" }, ctx)).rejects.toThrow(/not found/);
  });
});
