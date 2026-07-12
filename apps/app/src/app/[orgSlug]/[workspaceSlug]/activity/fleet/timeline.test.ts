import { describe, it, expect } from "vitest";
import { layoutTimeline, timelineEntriesFrom, type TimelineEntry } from "./timeline";
import type { AgentSubagentFanoutGetOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.get";
import type { AgentSubagentAggregateOutput } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";

function fanout(
  runs: AgentSubagentFanoutGetOutput["runs"],
): AgentSubagentFanoutGetOutput {
  return {
    fanoutId: "fo_1",
    parentMessageId: "msg_1",
    status: "running",
    totalChildren: runs.length,
    completedChildren: runs.filter((r) => r.status === "completed").length,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:05:00.000Z",
    runs,
  };
}

function run(
  overrides: Partial<AgentSubagentFanoutGetOutput["runs"][number]>,
): AgentSubagentFanoutGetOutput["runs"][number] {
  return {
    runId: "sar_1",
    capabilityName: "search_web",
    status: "completed",
    errorReason: null,
    startedAt: "2026-07-12T00:00:00.000Z",
    completedAt: "2026-07-12T00:01:00.000Z",
    durationMs: 60_000,
    inputBytes: 100,
    outputBytes: 200,
    outputPreview: null,
    ...overrides,
  };
}

describe("timelineEntriesFrom", () => {
  it("prefers aggregate.timeline when non-empty", () => {
    const agg: AgentSubagentAggregateOutput = {
      fanoutId: "fo_1",
      status: "running",
      totalChildren: 1,
      completedChildren: 0,
      aggregatedData: null,
      aggregatedDataTruncated: false,
      conflicts: [],
      timeline: [
        {
          runId: "sar_agg",
          capabilityName: "from_aggregate",
          status: "running",
          startedAt: "2026-07-12T00:00:00.000Z",
          completedAt: null,
          errorReason: null,
        },
      ],
      children: [],
      recheckAfterMs: 5000,
      firstError: null,
    };
    const entries = timelineEntriesFrom(fanout([run({ runId: "sar_get" })]), agg);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("sar_agg");
  });

  it("falls back to fanout.runs when aggregate is null", () => {
    const entries = timelineEntriesFrom(fanout([run({ runId: "sar_get" })]), null);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("sar_get");
  });

  it("falls back to fanout.runs when aggregate.timeline is empty (still-running compact mode)", () => {
    const agg: AgentSubagentAggregateOutput = {
      fanoutId: "fo_1",
      status: "running",
      totalChildren: 1,
      completedChildren: 0,
      aggregatedData: null,
      aggregatedDataTruncated: false,
      conflicts: [],
      timeline: [],
      children: [],
      recheckAfterMs: 5000,
      firstError: null,
    };
    const entries = timelineEntriesFrom(fanout([run({ runId: "sar_get" })]), agg);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.runId).toBe("sar_get");
  });
});

describe("layoutTimeline", () => {
  const now = "2026-07-12T00:10:00.000Z";

  it("returns a full-width bar when no entry has started", () => {
    const entries: TimelineEntry[] = [
      { runId: "a", capabilityName: "x", status: "pending", startedAt: null, completedAt: null, errorReason: null },
    ];
    const bars = layoutTimeline(entries, now);
    expect(bars).toEqual([{ ...entries[0], offsetPct: 0, widthPct: 100 }]);
  });

  it("positions a queued (not-yet-started) entry at the left edge with a minimal marker", () => {
    const entries: TimelineEntry[] = [
      {
        runId: "a",
        capabilityName: "started",
        status: "completed",
        startedAt: "2026-07-12T00:00:00.000Z",
        completedAt: "2026-07-12T00:02:00.000Z",
        errorReason: null,
      },
      { runId: "b", capabilityName: "queued", status: "pending", startedAt: null, completedAt: null, errorReason: null },
    ];
    const bars = layoutTimeline(entries, now);
    const queued = bars.find((b) => b.runId === "b")!;
    expect(queued.offsetPct).toBe(0);
    expect(queued.widthPct).toBe(2);
  });

  it("spans two sequential runs proportionally and clamps within [0,100]", () => {
    const entries: TimelineEntry[] = [
      {
        runId: "a",
        capabilityName: "first",
        status: "completed",
        startedAt: "2026-07-12T00:00:00.000Z",
        completedAt: "2026-07-12T00:05:00.000Z",
        errorReason: null,
      },
      {
        runId: "b",
        capabilityName: "second",
        status: "running",
        startedAt: "2026-07-12T00:05:00.000Z",
        completedAt: null,
        errorReason: null,
      },
    ];
    const bars = layoutTimeline(entries, now); // now = 00:10:00, range = 00:00–00:10 (10 min)
    const first = bars.find((b) => b.runId === "a")!;
    const second = bars.find((b) => b.runId === "b")!;
    expect(first.offsetPct).toBe(0);
    expect(first.widthPct).toBeCloseTo(50, 0); // 5 of 10 minutes
    expect(second.offsetPct).toBeCloseTo(50, 0);
    expect(second.widthPct).toBeCloseTo(50, 0); // still running -> ends at "now"
    for (const bar of bars) {
      expect(bar.offsetPct).toBeGreaterThanOrEqual(0);
      expect(bar.offsetPct + bar.widthPct).toBeLessThanOrEqual(100.001);
    }
  });
});
