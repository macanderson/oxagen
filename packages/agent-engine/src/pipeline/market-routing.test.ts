/**
 * Market-router engine integration tests.
 *
 * Covers the selectModel seam under off / shadow / enforce, and the onRouteOutcome
 * recording wire driven through a real runTurn with a fake AgentAi.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import { runTurn, selectMarketModel, type RouteOutcome } from "./index";
import type { RunTurnOptions } from "./index";
import { modelForTier } from "../router/model-router";
import type {
  MarketRoutingPolicy,
  RoutingStatRow,
} from "../router/market-router";
import { emptyUsage } from "../types";
import type { PromptEvaluation } from "../trace/types";
import type { AgentAi, ModelRunArgs } from "../ports";
import { scriptedEngine } from "./scripted-engine";

const HAIKU = "anthropic/claude-haiku-4.5";
const SONNET = modelForTier("balanced");

function evaluation(over: Partial<PromptEvaluation> = {}): PromptEvaluation {
  return {
    completeness: 80,
    complexity: 30,
    recommendedTier: "balanced",
    missing: [],
    contextQueries: [],
    refinedPrompt: "refactor the widget rendering",
    removed: [],
    reasoning: "",
    fallback: false,
    model: "evaluator",
    usage: emptyUsage(),
    ...over,
  };
}

const ENFORCE: MarketRoutingPolicy = {
  mode: "enforce",
  successThreshold: 0.95,
  minSamples: 20,
  windowDays: 30,
  escalateOnRejection: true,
};

// "refactor the widget rendering" → DESIGN_SIGNALS ⇒ deriveTaskClass "design/single".
const DESIGN_STATS: RoutingStatRow[] = [
  {
    taskClass: "design/single",
    model: HAIKU,
    tier: "fast",
    samples: 100,
    verifiedCount: 98,
    verifiedRate: 0.98,
    avgCostUsdMicros: 500,
    avgLatencyMs: 1000,
    lastSeen: "x",
  },
];

describe("selectMarketModel seam", () => {
  it("off / absent policy ⇒ today's deterministic routing (static)", () => {
    const out = selectMarketModel(
      { prompt: "x" } as RunTurnOptions,
      evaluation(),
    );
    expect(out.routingMode).toBe("static");
    expect(out.model).toBe(SONNET); // recommendedTier balanced
    expect(out.taskClass).toBe("design/single");
  });

  it("enforce ⇒ routes to the cheapest eligible market model", () => {
    const out = selectMarketModel(
      {
        prompt: "x",
        routingPolicy: ENFORCE,
        routingStats: DESIGN_STATS,
      } as RunTurnOptions,
      evaluation(),
    );
    expect(out.routingMode).toBe("enforce");
    expect(out.model).toBe(HAIKU); // cheaper and clears the 95% bar
    expect(out.rationale).toContain("market:enforce");
  });

  it("enforce with a manual pin ⇒ pin wins", () => {
    const out = selectMarketModel(
      {
        prompt: "x",
        model: "vendor/pinned",
        routingPolicy: ENFORCE,
        routingStats: DESIGN_STATS,
      } as RunTurnOptions,
      evaluation(),
    );
    expect(out.model).toBe("vendor/pinned");
  });

  it("shadow ⇒ keeps today's routing but annotates the market decision", () => {
    const out = selectMarketModel(
      {
        prompt: "x",
        routingPolicy: { ...ENFORCE, mode: "shadow" },
        routingStats: DESIGN_STATS,
      } as RunTurnOptions,
      evaluation(),
    );
    expect(out.routingMode).toBe("shadow");
    expect(out.model).toBe(SONNET); // deterministic model actually runs
    expect(out.rationale).toContain("market:shadow");
    expect(out.rationale).toContain("claude-haiku-4.5"); // what it WOULD pick
  });
});

// ── runTurn integration: onRouteOutcome recording ─────────────────────────────

function makeAi(editFile: string, judgeComplete = true): AgentAi {
  return {
    stream(args: ModelRunArgs) {
      return {
        fullStream: (async function* () {
          const editTool = args.tools.edit_file as {
            execute: (i: unknown, o: unknown) => Promise<unknown>;
          };
          await editTool.execute(
            { path: editFile, old_string: "before", new_string: "after" },
            {},
          );
          yield { type: "text-delta", text: "done" };
        })(),
        steps: Promise.resolve([{}]),
        usage: Promise.resolve({
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        }),
        response: Promise.resolve({ messages: [] }),
      } as unknown as ReturnType<AgentAi["stream"]>;
    },
    // Serves BOTH the evaluate and judge generateObject calls — carries every
    // field either stage reads, so the judge verdict is well-formed (a bare {}
    // leaves verdict.reasoning undefined and trace assembly truncates it).
    generateObject: async () => ({
      object: {
        completeness: 80,
        complexity: 30,
        recommendedTier: "balanced",
        missing: [],
        contextQueries: [],
        refinedPrompt: "refactor the widget rendering",
        removed: [],
        reasoning: judgeComplete ? "looks complete" : "still missing tests",
        complete: judgeComplete,
        confidence: 90,
        findings: judgeComplete ? [] : ["add a test"],
        remainingWork: [],
      } as never,
      usage: { totalTokens: 0 },
    }),
  };
}

describe("runTurn — onRouteOutcome", () => {
  it("records a routing outcome for the round with mode=static by default", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const outcomes: RouteOutcome[] = [];
    await runTurn({
      execute: scriptedEngine,
      prompt: "refactor the widget rendering in src/a.ts",
      workspace: ws,
      ai: makeAi("src/a.ts"),
      bare: false,
      maxReviseRounds: 0,
      onRouteOutcome: (o) => {
        outcomes.push(o);
      },
    });
    expect(outcomes).toHaveLength(1);
    const o = outcomes[0]!;
    expect(o.routingMode).toBe("static");
    expect(o.round).toBe(0);
    expect(o.taskClass).toBe("design/single");
    expect(o.model).toBe(SONNET);
    expect(o.signatureHash).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
    expect(o.costUsdMicros).toBeGreaterThan(0);
    expect(["tests", "judge", "completion"]).toContain(o.verificationSource);
  });

  it("enforce mode records the market-chosen model as the model that ran", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const outcomes: RouteOutcome[] = [];
    await runTurn({
      execute: scriptedEngine,
      prompt: "refactor the widget rendering in src/a.ts",
      workspace: ws,
      ai: makeAi("src/a.ts"),
      bare: false,
      maxReviseRounds: 0,
      routingPolicy: ENFORCE,
      routingStats: DESIGN_STATS,
      onRouteOutcome: (o) => {
        outcomes.push(o);
      },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.routingMode).toBe("enforce");
    expect(outcomes[0]!.model).toBe(HAIKU); // market picked the cheap eligible model
  });

  it("enforce mode escalates the worker one tier on judge rejection", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const outcomes: RouteOutcome[] = [];
    await runTurn({
      execute: scriptedEngine,
      prompt: "refactor the widget rendering in src/a.ts",
      workspace: ws,
      // judgeComplete=false ⇒ every round is rejected, forcing a revise round.
      ai: makeAi("src/a.ts", false),
      bare: false,
      maxReviseRounds: 1,
      routingPolicy: ENFORCE, // escalateOnRejection: true
      routingStats: DESIGN_STATS, // market picks HAIKU (fast tier) for round 0
      onRouteOutcome: (o) => {
        outcomes.push(o);
      },
    });
    // Round 0 ran the market pick (fast tier); round 1 escalated one tier.
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.tier).toBe("fast");
    expect(outcomes[0]!.model).toBe(HAIKU);
    expect(outcomes[1]!.tier).toBe("balanced"); // escalated fast → balanced
    expect(outcomes[1]!.model).toBe(SONNET);
  });

  it("a throwing onRouteOutcome never fails the turn", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "before" });
    const result = await runTurn({
      execute: scriptedEngine,
      prompt: "refactor the widget rendering in src/a.ts",
      workspace: ws,
      ai: makeAi("src/a.ts"),
      bare: false,
      maxReviseRounds: 0,
      onRouteOutcome: () => {
        throw new Error("telemetry boom");
      },
    });
    expect(result.text).toBeTruthy();
  });
});
