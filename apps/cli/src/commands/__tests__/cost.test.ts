/**
 * `oxagen cost` — proves the projection, comparison, rate-card dump, and session
 * rollup render correctly and that --json is machine-readable. The trace store is
 * mocked so the session rollup is deterministic and touches no filesystem.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import type { TurnTrace } from "../../agent/trace.js";

vi.mock("../../agent/trace-store.js", () => ({ openTraceStore: vi.fn() }));

import { handleCost } from "../cost.js";
import { openTraceStore } from "../../agent/trace-store.js";

const mockStore = openTraceStore as unknown as Mock;

let out = "";
let write: typeof process.stdout.write;

beforeEach(() => {
  out = "";
  write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => {
    out += s;
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
});

afterEach(() => {
  process.stdout.write = write;
  process.exitCode = 0;
});

function turn(over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    id: "t",
    createdAt: 1,
    cwd: "/proj",
    originalPrompt: "x",
    evaluation: {
      completeness: 50,
      complexity: 50,
      recommendedTier: "balanced",
      missing: [],
      contextQueries: [],
      refinedPrompt: "x",
      removed: [],
      reasoning: "",
      fallback: false,
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    },
    enhancement: {
      prompt: "x",
      context: "",
      resolved: [],
      lessonCount: 0,
      source: "none",
    },
    selectedModel: "anthropic/claude-sonnet-5",
    selectedTier: "balanced",
    selectionRationale: "r",
    response: "ok",
    filesTouched: [],
    commandsRun: [],
    judgeRounds: [],
    finalComplete: true,
    steps: 1,
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.05 },
    durationMs: 2000,
    ...over,
  };
}

describe("cost --rates", () => {
  it("prints the baked-in rate card with vendors and prices", async () => {
    await handleCost({ rates: true });
    expect(out).toContain("Claude Opus");
    expect(out).toContain("anthropic");
    expect(out).toContain("$15");
  });

  it("emits JSON with --json", async () => {
    await handleCost({ rates: true, json: true });
    const parsed = JSON.parse(out) as Array<{ family: string }>;
    expect(parsed.some((e) => e.family === "claude-opus")).toBe(true);
  });
});

describe("cost projection", () => {
  it("compares every model cheapest-first and reports the spread", async () => {
    await handleCost({ in: 1_000_000, out: 1_000_000 });
    expect(out).toContain("cheapest:");
    expect(out).toContain("GPT-4o mini");
    expect(out).toContain("× cheaper");
  });

  it("projects a single model with --model and --json", async () => {
    await handleCost({
      in: 1_000_000,
      out: 0,
      model: "anthropic/claude-opus-4.8",
      json: true,
    });
    const p = JSON.parse(out) as { totalUsd: number; vendor: string };
    expect(p.vendor).toBe("anthropic");
    expect(p.totalUsd).toBeCloseTo(15);
  });

  it("errors when no token counts are given", async () => {
    await handleCost({});
    expect(process.exitCode).toBe(1);
    expect(out).toContain("Provide token counts");
  });
});

describe("cost --session", () => {
  it("rolls up recorded turns by model, attributing per-phase when present", async () => {
    const phased = turn({
      id: "t1",
      phases: [
        {
          phase: "evaluate",
          round: 0,
          startedAt: 0,
          finishedAt: 10,
          durationMs: 10,
          model: "anthropic/claude-haiku-4.5",
          usage: { inputTokens: 20, outputTokens: 5, costUsd: 0.001 },
        },
        {
          phase: "execute",
          round: 0,
          startedAt: 10,
          finishedAt: 1000,
          durationMs: 990,
          model: "anthropic/claude-sonnet-5",
          usage: { inputTokens: 80, outputTokens: 45, costUsd: 0.049 },
        },
      ],
      verbose: true,
    });
    mockStore.mockReturnValue({ list: () => [phased] });

    await handleCost({ session: true });
    expect(out).toContain("Session cost rollup");
    expect(out).toContain("claude-haiku-4.5");
    expect(out).toContain("claude-sonnet-5");
    expect(out).toContain("total:");
  });

  it("reports nothing recorded for an empty store", async () => {
    mockStore.mockReturnValue({ list: () => [] });
    await handleCost({ session: true });
    expect(out).toContain("No turns recorded");
  });

  it("attributes a non-phased (pre-verbose / bare) trace to its executor model", async () => {
    // No `phases` → attribute() falls back to selectedModel + trace.usage.
    mockStore.mockReturnValue({ list: () => [turn({ id: "t1" })] });
    await handleCost({ session: true, json: true });
    const r = JSON.parse(out) as {
      turns: number;
      totalCostUsd: number;
      byModel: Array<{
        model: string;
        costUsd: number;
        inputTokens: number;
        turns: number;
      }>;
    };
    expect(r.turns).toBe(1);
    expect(r.totalCostUsd).toBeCloseTo(0.05);
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0]?.model).toBe("anthropic/claude-sonnet-5");
    expect(r.byModel[0]?.costUsd).toBeCloseTo(0.05);
    expect(r.byModel[0]?.inputTokens).toBe(100);
    expect(r.byModel[0]?.turns).toBe(1);
  });

  it("attributes per-phase spend to each model numerically (--json)", async () => {
    const phased = turn({
      id: "t1",
      phases: [
        {
          phase: "evaluate",
          round: 0,
          startedAt: 0,
          finishedAt: 10,
          durationMs: 10,
          model: "anthropic/claude-haiku-4.5",
          usage: { inputTokens: 20, outputTokens: 5, costUsd: 0.001 },
        },
        {
          phase: "execute",
          round: 0,
          startedAt: 10,
          finishedAt: 1000,
          durationMs: 990,
          model: "anthropic/claude-sonnet-5",
          usage: { inputTokens: 80, outputTokens: 45, costUsd: 0.049 },
        },
      ],
    });
    mockStore.mockReturnValue({ list: () => [phased] });
    await handleCost({ session: true, json: true });
    const r = JSON.parse(out) as {
      byModel: Array<{ model: string; costUsd: number; turns: number }>;
    };
    const haiku = r.byModel.find((m) => m.model.includes("haiku"));
    const sonnet = r.byModel.find((m) => m.model.includes("sonnet"));
    expect(haiku?.costUsd).toBeCloseTo(0.001);
    expect(sonnet?.costUsd).toBeCloseTo(0.049);
    // Turns are counted by executor (selectedModel = sonnet), not per phase.
    expect(sonnet?.turns).toBe(1);
    expect(haiku?.turns).toBe(0);
  });
});
