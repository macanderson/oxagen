/**
 * Tests for the results reader + aggregators.
 *
 * The pure aggregators (`computeQuickStats`, `agentComparison`,
 * `taskBreakdown`, `historySeries`, `recentResults`) run against in-memory
 * fixtures. The filesystem readers (`readResults`, `readHistory`) run against a
 * mocked `fs` so we can prove the summary-expansion / de-dup / validation
 * behavior deterministically, without depending on real `results/` on disk.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { BenchmarkResult, TrackerEntry } from "./types";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(),
  };
});

// Imported after the mock is registered (vi.mock is hoisted above imports).
import { existsSync, readdirSync, readFileSync } from "fs";
import {
  readResults,
  readHistory,
  computeQuickStats,
  agentComparison,
  taskBreakdown,
  historySeries,
  recentResults,
} from "./results";

const existsMock = vi.mocked(existsSync);
const readdirMock = vi.mocked(readdirSync);
const readFileMock = vi.mocked(readFileSync);

function makeResult(over: {
  id: string;
  taskId?: string;
  type?: BenchmarkResult["agent"]["type"];
  model?: string;
  success?: boolean;
  cost?: number;
  duration?: number;
  runDate?: string;
}): BenchmarkResult {
  return {
    id: over.id,
    taskId: over.taskId ?? "task-1",
    agent: { type: over.type ?? "oxagen", model: over.model ?? "anthropic/claude-opus-4.8" },
    metrics: {
      success: over.success ?? true,
      criteriaPassed: [],
      criteriaFailed: [],
      durationSeconds: over.duration ?? 10,
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      totalCost: over.cost ?? 0.25,
      toolCalls: 3,
      filesTouched: 1,
      linesAdded: 5,
      linesRemoved: 2,
      diffSize: 128,
      iterations: 1,
    },
    provenance: {
      kind: "measured",
      runId: `run-${over.id}`,
      runDate: over.runDate ?? "2026-07-10T00:00:00.000Z",
      gitSha: "abc1234",
    },
    prompt: "p",
    diff: "d",
    output: "o",
  };
}

const entry = (over: Partial<TrackerEntry> & { date: string }): TrackerEntry => ({
  agentType: "oxagen",
  model: "anthropic/claude-opus-4.8",
  successRate: 0.8,
  avgCost: 0.15,
  avgDuration: 35,
  tasksCompleted: 40,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readResults", () => {
  it("expands summary.json results[] and de-dupes flat copies by id", () => {
    const a = makeResult({ id: "res-a", taskId: "t1", type: "oxagen" });
    const b = makeResult({ id: "res-b", taskId: "t1", type: "stella", model: "glm-5.2" });

    existsMock.mockReturnValue(true);
    readdirMock.mockReturnValue([
      "run-1/summary.json",
      "run-1/res-a.json", // duplicate copy of `a` — must not double-count
    ] as unknown as ReturnType<typeof readdirSync>);
    readFileMock.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith("summary.json")) {
        return JSON.stringify({
          metadata: { runDate: "2026-07-10T00:00:00.000Z" },
          results: [a, b],
        });
      }
      return JSON.stringify(a);
    });

    const rows = readResults();
    const ids = rows.map((r) => r.result.id).sort();
    // `res-b` exists only inside the summary — proves recovery when a per-result
    // file is missing (e.g. a "/" in the model id broke the flat write).
    expect(ids).toEqual(["res-a", "res-b"]);
    expect(rows.every((r) => r.runDate === "2026-07-10T00:00:00.000Z")).toBe(true);
  });

  it("returns [] when the results directory is absent", () => {
    existsMock.mockReturnValue(false);
    expect(readResults()).toEqual([]);
  });

  it("skips malformed / non-result JSON", () => {
    existsMock.mockReturnValue(true);
    readdirMock.mockReturnValue([
      "run-1/broken.json",
      "run-1/not-a-result.json",
    ] as unknown as ReturnType<typeof readdirSync>);
    readFileMock.mockImplementation((p) =>
      String(p).endsWith("broken.json") ? "{not json" : JSON.stringify({ hello: "world" }),
    );
    expect(readResults()).toEqual([]);
  });
});

describe("readHistory", () => {
  it("reads, validates, and sorts entries oldest → newest; drops malformed", () => {
    existsMock.mockReturnValue(true);
    readFileMock.mockReturnValue(
      JSON.stringify([
        entry({ date: "2026-07-08", successRate: 0.81 }),
        entry({ date: "2026-07-01", successRate: 0.75 }),
        { date: "2026-07-05", successRate: 2 }, // invalid: rate > 1 → dropped
      ]),
    );
    const hist = readHistory();
    expect(hist.map((h) => h.date)).toEqual(["2026-07-01", "2026-07-08"]);
  });

  it("returns [] when the history file is absent", () => {
    existsMock.mockReturnValue(false);
    expect(readHistory()).toEqual([]);
  });
});

describe("computeQuickStats", () => {
  it("computes success rate, total cost, and average duration", () => {
    const rows = [
      { result: makeResult({ id: "1", success: true, cost: 0.2, duration: 10 }) },
      { result: makeResult({ id: "2", success: false, cost: 0.3, duration: 20 }) },
    ];
    const stats = computeQuickStats(rows);
    expect(stats.totalResults).toBe(2);
    expect(stats.successRate).toBe(0.5);
    expect(stats.totalCost).toBeCloseTo(0.5);
    expect(stats.avgDuration).toBe(15);
  });

  it("returns zeros for no rows", () => {
    expect(computeQuickStats([])).toEqual({
      totalResults: 0,
      successRate: 0,
      totalCost: 0,
      avgDuration: 0,
    });
  });
});

describe("agentComparison", () => {
  it("groups by agent+model and computes per-agent success rate", () => {
    const rows = [
      { result: makeResult({ id: "1", type: "oxagen", success: true }) },
      { result: makeResult({ id: "2", type: "oxagen", success: false }) },
      { result: makeResult({ id: "3", type: "stella", model: "glm-5.2", success: true }) },
    ];
    const { agents } = agentComparison(rows);
    const oxagen = agents.find((a) => a.type === "oxagen");
    const stella = agents.find((a) => a.type === "stella");
    expect(oxagen?.runCount).toBe(2);
    expect(oxagen?.successRate).toBe(0.5);
    expect(stella?.runCount).toBe(1);
    expect(stella?.successRate).toBe(1);
  });
});

describe("taskBreakdown", () => {
  it("builds a task × agent matrix with per-cell success rate and cost", () => {
    const rows = [
      { result: makeResult({ id: "1", taskId: "t1", type: "oxagen", success: true, cost: 0.2 }) },
      { result: makeResult({ id: "2", taskId: "t1", type: "stella", model: "glm-5.2", success: false, cost: 0.1 }) },
      { result: makeResult({ id: "3", taskId: "t2", type: "oxagen", success: false, cost: 0.4 }) },
    ];
    const bd = taskBreakdown(rows);
    expect(bd.agents.map((a) => a.type)).toEqual(["oxagen", "stella"]);
    expect(bd.rows.map((r) => r.taskId)).toEqual(["t1", "t2"]);

    const oxKey = bd.agents.find((a) => a.type === "oxagen")!.key;
    const stKey = bd.agents.find((a) => a.type === "stella")!.key;
    const t1 = bd.rows.find((r) => r.taskId === "t1")!;
    const t2 = bd.rows.find((r) => r.taskId === "t2")!;

    expect(t1.cells[oxKey].successRate).toBe(1);
    expect(t1.cells[stKey].successRate).toBe(0);
    // stella never ran t2 → no cell (rendered as "—").
    expect(t2.cells[stKey]).toBeUndefined();
    expect(t2.cells[oxKey].avgCost).toBeCloseTo(0.4);
  });
});

describe("historySeries", () => {
  it("groups per agent+model with first/latest deltas", () => {
    const entries = [
      entry({ date: "2026-07-01", successRate: 0.75, avgCost: 0.18 }),
      entry({ date: "2026-07-08", successRate: 0.81, avgCost: 0.15 }),
    ];
    const [series] = historySeries(entries);
    expect(series.points).toHaveLength(2);
    expect(series.first.date).toBe("2026-07-01");
    expect(series.latest.date).toBe("2026-07-08");
    expect(series.successRateDelta).toBeCloseTo(0.06);
    expect(series.costDelta).toBeCloseTo(-0.03);
  });

  it("reports a zero delta for a single snapshot", () => {
    const [series] = historySeries([entry({ date: "2026-07-01" })]);
    expect(series.successRateDelta).toBe(0);
    expect(series.costDelta).toBe(0);
  });
});

describe("recentResults", () => {
  it("sorts by run date descending and respects the limit", () => {
    const rows = [
      { result: makeResult({ id: "old" }), runDate: "2026-07-01T00:00:00.000Z" },
      { result: makeResult({ id: "new" }), runDate: "2026-07-09T00:00:00.000Z" },
      { result: makeResult({ id: "mid" }), runDate: "2026-07-05T00:00:00.000Z" },
    ];
    const out = recentResults(rows, 2);
    expect(out.map((r) => r.id)).toEqual(["new", "mid"]);
  });
});
