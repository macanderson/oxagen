/**
 * Verbose trace rendering — proves formatVerboseSection surfaces the headline:
 * the per-model rollup (which model did work vs review and what each cost), the
 * per-phase timeline, tool calls + results, the injected context, and the
 * efficiency metrics. Also proves formatTraceText appends it only for verbose
 * turns.
 */
import { describe, it, expect } from "vitest";
import { formatVerboseSection, formatTraceText } from "../trace-format.js";
import type { TurnTrace } from "../trace.js";

function trace(over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    id: "turn_x",
    createdAt: 1,
    cwd: "/proj",
    originalPrompt: "fix the login bug",
    evaluation: {
      completeness: 60,
      complexity: 55,
      recommendedTier: "balanced",
      missing: [],
      contextQueries: [],
      refinedPrompt: "fix the login bug",
      removed: [],
      reasoning: "",
      fallback: false,
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.001 },
    },
    enhancement: {
      prompt: "p",
      context: "Definitions of `Login`:\n  src/auth.ts",
      resolved: ["Login"],
      lessonCount: 1,
      source: "code-graph",
      durationMs: 42,
      retrieval: {
        symbolsQueried: ["Login", "Ghost"],
        pathsQueried: [],
        resolved: ["Login"],
        unresolved: ["Ghost"],
      },
    },
    selectedModel: "anthropic/claude-sonnet-5",
    selectedTier: "balanced",
    selectionRationale: "evaluator recommended",
    response: "done",
    filesTouched: ["src/auth.ts"],
    commandsRun: [],
    judgeRounds: [],
    finalComplete: true,
    steps: 4,
    usage: { inputTokens: 108, outputTokens: 52, costUsd: 0.052 },
    durationMs: 3000,
    verbose: true,
    phases: [
      {
        phase: "evaluate",
        round: 0,
        startedAt: 0,
        finishedAt: 30,
        durationMs: 30,
        model: "anthropic/claude-haiku-4.5",
        usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.001 },
      },
      {
        phase: "enhance",
        round: 0,
        startedAt: 30,
        finishedAt: 72,
        durationMs: 42,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
      {
        phase: "execute",
        round: 0,
        startedAt: 72,
        finishedAt: 2500,
        durationMs: 2428,
        model: "anthropic/claude-sonnet-5",
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.049 },
      },
      {
        phase: "judge",
        round: 0,
        startedAt: 2500,
        finishedAt: 3000,
        durationMs: 500,
        model: "anthropic/claude-opus-4.8",
        usage: { inputTokens: 3, outputTokens: 1, costUsd: 0.002 },
      },
    ],
    toolEvents: [
      {
        name: "edit_file",
        input: '{"path":"src/auth.ts"}',
        result: "ok",
        startedAt: 100,
        finishedAt: 320,
        durationMs: 220,
        ok: true,
      },
    ],
    ...over,
  };
}

describe("formatVerboseSection", () => {
  it("renders the per-model rollup, phases, tools, context, and efficiency", () => {
    const text = formatVerboseSection(trace()).join("\n");
    // Per-model rollup names each model with its role.
    expect(text).toContain("models used");
    expect(text).toContain("claude-sonnet-5");
    expect(text).toContain("WORK (code)");
    expect(text).toContain("claude-opus-4.8");
    expect(text).toContain("REVIEW (judge)");
    // Phase timeline + tool result.
    expect(text).toContain("phases");
    expect(text).toContain("edit_file");
    expect(text).toContain("→ ok");
    // Context-gather detail incl. the injected context and unresolved candidate.
    expect(text).toContain("context gathering");
    expect(text).toContain("Ghost");
    expect(text).toContain("Definitions of `Login`");
    // Efficiency metrics.
    expect(text).toContain("efficiency");
    expect(text).toContain("tok/s");
    expect(text).toContain("/file");
  });

  it("marks a failed tool call with the error glyph", () => {
    const text = formatVerboseSection(
      trace({
        toolEvents: [
          {
            name: "bash",
            input: '{"command":"pnpm test"}',
            result: "1 failed",
            startedAt: 0,
            finishedAt: 50,
            durationMs: 50,
            ok: false,
          },
        ],
      }),
    ).join("\n");
    expect(text).toContain("✗ bash");
  });

  it("returns nothing when there is no telemetry", () => {
    expect(formatVerboseSection(trace({ phases: [], toolEvents: [] }))).toEqual(
      [],
    );
  });
});

describe("formatTraceText", () => {
  it("appends the verbose section for a verbose turn", () => {
    expect(formatTraceText(trace())).toContain("verbose telemetry");
  });

  it("omits the verbose section for a normal turn", () => {
    const normal = trace({
      verbose: undefined,
      phases: undefined,
      toolEvents: undefined,
    });
    expect(formatTraceText(normal)).not.toContain("verbose telemetry");
  });
});
