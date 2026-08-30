/**
 * Plain-text trace rendering — proves the report includes every section (prompt,
 * scores, refined prompt, injected context, model, judge rounds) and that the
 * conditional sections (refined prompt, bare-mode "not judged", the list) behave.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../lib/config.js", () => ({ readConfig: () => ({}) }));

import { formatTraceText, formatTraceList } from "../trace-format.js";
import type { TurnTrace, JudgeVerdict } from "../trace.js";

function judge(over: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    complete: false,
    confidence: 80,
    findings: ["missing migration"],
    remainingWork: ["write it"],
    reasoning: "tests absent",
    model: "anthropic/claude-opus-4.8",
    fallback: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ...over,
  };
}

function trace(over: Partial<TurnTrace> = {}): TurnTrace {
  return {
    id: "turn_1",
    createdAt: 1,
    cwd: "/x",
    originalPrompt: "add a refund route",
    evaluation: {
      completeness: 72,
      complexity: 60,
      recommendedTier: "balanced",
      missing: ["which file"],
      contextQueries: [],
      refinedPrompt: "add refund route to billing api",
      removed: ["please"],
      reasoning: "fairly clear",
      fallback: false,
      model: "anthropic/claude-haiku-4.5",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    },
    enhancement: {
      prompt: "add refund route to billing api\n\n## ctx",
      context: "## ctx",
      resolved: ["refundHandler"],
      lessonCount: 2,
      source: "code-graph+memory",
    },
    selectedModel: "anthropic/claude-opus-4.8",
    selectedTier: "precise",
    selectionRationale: "router escalated — billing",
    response: "added it",
    filesTouched: ["src/billing/refund.ts"],
    commandsRun: ["pnpm test"],
    judgeRounds: [
      judge(),
      judge({ complete: true, findings: [], remainingWork: [] }),
    ],
    finalComplete: true,
    steps: 7,
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0123 },
    durationMs: 4200,
    ...over,
  };
}

describe("formatTraceText", () => {
  it("renders every section with scores, context, model, and judge rounds", () => {
    const out = formatTraceText(trace());
    expect(out).toContain("1 · Original prompt");
    expect(out).toContain("add a refund route");
    expect(out).toContain("completeness");
    expect(out).toContain("72/100");
    expect(out).toContain("3 · Refined prompt");
    expect(out).toContain("add refund route to billing api");
    expect(out).toContain("4 · Injected context · code-graph+memory");
    expect(out).toContain("refundHandler");
    expect(out).toContain("5 · Model selected");
    expect(out).toContain("opus");
    expect(out).toContain("round 1: INCOMPLETE");
    expect(out).toContain("round 2: COMPLETE");
    expect(out).toContain("missing migration");
    expect(out).toContain("src/billing/refund.ts");
  });

  it("omits the refined-prompt section when unchanged, and shows bare-mode judging", () => {
    const out = formatTraceText(
      trace({
        evaluation: {
          ...trace().evaluation,
          refinedPrompt: "add a refund route",
          missing: [],
          removed: [],
          reasoning: "",
        },
        enhancement: {
          prompt: "p",
          context: "",
          resolved: [],
          lessonCount: 0,
          source: "none",
        },
        judgeRounds: [],
      }),
    );
    expect(out).not.toContain("3 · Refined prompt");
    expect(out).toContain("no code-graph references resolved");
    expect(out).toContain("not judged (bare mode)");
  });
});

describe("formatTraceList", () => {
  it("summarizes newest-first with a status mark", () => {
    const out = formatTraceList([
      trace({ id: "a", originalPrompt: "first", finalComplete: true }),
      trace({ id: "b", originalPrompt: "second", finalComplete: false }),
    ]);
    expect(out).toContain("1. ✓ first");
    expect(out).toContain("2. ✗ second");
  });

  it("handles the empty case", () => {
    expect(formatTraceList([])).toBe("No turns recorded yet.");
  });
});
