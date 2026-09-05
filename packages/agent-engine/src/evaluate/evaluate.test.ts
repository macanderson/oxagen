/**
 * Tests for the engine's evaluate sub-package.
 *
 * Tests evaluatePrompt, judgeCompleteness, buildRevisionPrompt, and
 * enhancePrompt via mocked AgentAi ports — never hits the gateway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  evaluatePrompt,
  LOCAL_EVALUATOR,
  evalSchema,
  EVALUATOR_SYSTEM,
} from "./evaluator";
import {
  judgeCompleteness,
  judgePanel,
  pickJudgePanel,
  buildRevisionPrompt,
  pickAdvisorModel,
  DEFAULT_ADVISOR_MODEL,
} from "./judge";
import { enhancePrompt } from "./prompt-enhancer";
import type { AgentAi } from "../ports";
import { emptyUsage } from "../types";

// A fatal auth/billing error — see isFatalAuthOrBillingError in ../loop-driver.
// Every fallback site below must re-throw this instead of swallowing it into a
// "keep going" heuristic, since every later model call would fail identically.
const FATAL_ERROR = new Error(
  "A positive credit balance is required for all requests, please add credits.",
);

// ── helpers ───────────────────────────────────────────────────────────────────

function makeAi(overrides: Partial<AgentAi> = {}): AgentAi {
  return {
    stream: vi.fn() as AgentAi["stream"],
    generateObject: vi.fn() as AgentAi["generateObject"],
    ...overrides,
  };
}

// ── evaluatePrompt ────────────────────────────────────────────────────────────

// The default evaluator is the local heuristic; these tests pass an explicit
// model slug to exercise the LLM-evaluation path.
const LLM_EVALUATOR = "anthropic/claude-haiku-4.5";

describe("evaluatePrompt", () => {
  it("defaults to the local heuristic coordinator — no model call", async () => {
    const generateObject = vi.fn();
    const ai = makeAi({
      generateObject: generateObject as AgentAi["generateObject"],
    });

    const result = await evaluatePrompt({ prompt: "fix the auth bug" }, ai);

    expect(generateObject).not.toHaveBeenCalled();
    expect(result.model).toBe(LOCAL_EVALUATOR);
    expect(result.fallback).toBe(false);
    // Auth-related prompt → precise tier from the deterministic router
    expect(result.recommendedTier).toBe("precise");
    expect(result.refinedPrompt).toBe("fix the auth bug");
    expect(result.usage.inputTokens).toBe(0);
  });

  it("returns model output when ai.generateObject succeeds", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockResolvedValue({
        object: {
          completeness: 80,
          complexity: 40,
          recommendedTier: "balanced",
          missing: [],
          refinedPrompt: "Fix the login timeout bug in src/auth/session.ts",
          removed: ["please"],
          reasoning: "Well-scoped task.",
        },
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });

    const result = await evaluatePrompt(
      {
        prompt: "please fix the login timeout bug in src/auth/session.ts",
        model: LLM_EVALUATOR,
      },
      ai,
    );

    expect(result.completeness).toBe(80);
    expect(result.complexity).toBe(40);
    expect(result.recommendedTier).toBe("balanced");
    expect(result.refinedPrompt).toContain("Fix the login timeout");
    expect(result.fallback).toBe(false);
    expect(result.usage.inputTokens).toBe(100);
  });

  // Witness for #2594: contextQueries named symbols/files "worth pulling from
  // the code graph" — a subsystem the platform doesn't have (the enhancer's
  // graph lookups are gone). The field is retired: the schema no longer
  // declares it, the prompt no longer asks for it, and a model that still
  // volunteers it must not have that value survive into the evaluation or
  // the trace it feeds.
  it("no longer declares or forwards contextQueries (#2594)", async () => {
    expect("contextQueries" in evalSchema.shape).toBe(false);
    expect(EVALUATOR_SYSTEM).not.toContain("contextQueries");
    expect(EVALUATOR_SYSTEM).not.toContain("code graph");

    const ai = makeAi({
      generateObject: vi.fn().mockResolvedValue({
        object: {
          completeness: 80,
          complexity: 40,
          recommendedTier: "balanced",
          missing: [],
          // A model that ignores the (now-absent) instruction and volunteers
          // the field anyway must not have it survive into the result.
          contextQueries: ["loginUser"],
          refinedPrompt: "Fix the login timeout bug in src/auth/session.ts",
          removed: [],
          reasoning: "Well-scoped task.",
        },
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });

    const result = await evaluatePrompt(
      { prompt: "fix the login timeout bug", model: LLM_EVALUATOR },
      ai,
    );

    expect("contextQueries" in result).toBe(false);
  });

  it("falls back to heuristic when ai.generateObject throws", async () => {
    const ai = makeAi({
      generateObject: vi
        .fn()
        .mockRejectedValue(new Error("gateway unavailable")),
    });

    const result = await evaluatePrompt(
      { prompt: "fix the auth bug", model: LLM_EVALUATOR },
      ai,
    );

    expect(result.fallback).toBe(true);
    // Auth-related prompt → precise tier heuristically
    expect(result.recommendedTier).toBe("precise");
    // Prompt is returned unchanged by the heuristic
    expect(result.refinedPrompt).toBe("fix the auth bug");
  });

  it("re-throws instead of falling back when the error is a fatal auth/billing error", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockRejectedValue(FATAL_ERROR),
    });

    // Every later call (route/execute/judge) would fail identically, so a
    // heuristic fallback here would just delay the real error — it must
    // propagate instead.
    await expect(
      evaluatePrompt({ prompt: "fix the auth bug", model: LLM_EVALUATOR }, ai),
    ).rejects.toThrow(/positive credit balance/);
  });

  it("falls back to original prompt when refined prompt is empty", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockResolvedValue({
        object: {
          completeness: 50,
          complexity: 30,
          recommendedTier: "fast",
          missing: [],
          refinedPrompt: "  ", // empty after trim
          removed: [],
          reasoning: "short prompt",
        },
        usage: emptyUsage(),
      }),
    });

    const result = await evaluatePrompt(
      { prompt: "rename the thing", model: LLM_EVALUATOR },
      ai,
    );
    expect(result.refinedPrompt).toBe("rename the thing");
  });

  it("clamps scores outside 0–100", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockResolvedValue({
        object: {
          completeness: 150, // over 100
          complexity: -10, // under 0
          recommendedTier: "fast",
          missing: [],
          refinedPrompt: "do it",
          removed: [],
          reasoning: "test",
        },
        usage: emptyUsage(),
      }),
    });

    const result = await evaluatePrompt(
      { prompt: "do it", model: LLM_EVALUATOR },
      ai,
    );
    expect(result.completeness).toBe(100);
    expect(result.complexity).toBe(0);
  });
});

// ── judgeCompleteness ─────────────────────────────────────────────────────────

describe("judgeCompleteness", () => {
  it("returns complete verdict when ai says so", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockResolvedValue({
        object: {
          complete: true,
          confidence: 95,
          findings: [],
          remainingWork: [],
          reasoning: "All changes were made correctly.",
        },
        usage: { inputTokens: 200, outputTokens: 80 },
      }),
    });

    const result = await judgeCompleteness(
      {
        request: "Add a button to the header",
        response: "I've added the Button component to Header.tsx",
        filesTouched: ["src/components/Header.tsx"],
        commandsRun: [],
        steps: 3,
        executorModel: "anthropic/claude-sonnet-5",
      },
      ai,
    );

    expect(result.complete).toBe(true);
    expect(result.confidence).toBe(95);
    expect(result.fallback).toBe(false);
  });

  it("returns incomplete verdict with findings", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockResolvedValue({
        object: {
          complete: false,
          confidence: 80,
          findings: ["Tests were not added"],
          remainingWork: ["Add unit tests for the new button"],
          reasoning: "The button was added but tests are missing.",
        },
        usage: emptyUsage(),
      }),
    });

    const result = await judgeCompleteness(
      {
        request: "Add a button with tests",
        response: "I added the button",
        filesTouched: ["src/Button.tsx"],
        commandsRun: [],
        steps: 2,
        executorModel: "anthropic/claude-haiku-4.5",
      },
      ai,
    );

    expect(result.complete).toBe(false);
    expect(result.findings).toContain("Tests were not added");
  });

  it("falls back to heuristic when ai throws", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    const result = await judgeCompleteness(
      {
        request: "Create a new file",
        response: "I created the file",
        filesTouched: [],
        commandsRun: [],
        steps: 0,
        executorModel: "anthropic/claude-opus-4.8",
      },
      ai,
    );

    expect(result.fallback).toBe(true);
    // Claims change but touched nothing → heuristic marks incomplete
    expect(result.complete).toBe(false);
  });

  it("re-throws instead of falling back when the error is a fatal auth/billing error", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockRejectedValue(FATAL_ERROR),
    });

    // A heuristic "looks complete" verdict here would mask that the account is
    // out of credits — the turn must fail fast with the real message instead.
    await expect(
      judgeCompleteness(
        {
          request: "Create a new file",
          response: "I created the file",
          filesTouched: [],
          commandsRun: [],
          steps: 0,
          executorModel: "anthropic/claude-opus-4.8",
        },
        ai,
      ),
    ).rejects.toThrow(/positive credit balance/);
  });

  it("heuristic marks complete when no obvious incompleteness", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    const result = await judgeCompleteness(
      {
        request: "What does this code do?",
        response: "This code implements an auth module.",
        filesTouched: [],
        commandsRun: [],
        steps: 1,
        executorModel: "anthropic/claude-haiku-4.5",
      },
      ai,
    );

    expect(result.fallback).toBe(true);
    expect(result.complete).toBe(true); // read-only ask, no change expected
  });

  it("clamps confidence to 0–100", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockResolvedValue({
        object: {
          complete: true,
          confidence: 110, // over 100
          findings: [],
          remainingWork: [],
          reasoning: "test",
        },
        usage: emptyUsage(),
      }),
    });

    const result = await judgeCompleteness(
      {
        request: "test",
        response: "done",
        filesTouched: [],
        commandsRun: [],
        steps: 0,
        executorModel: "some/model",
      },
      ai,
    );

    expect(result.confidence).toBe(100);
  });

  it("puts the git diff and command outputs (evidence) into the judge prompt", async () => {
    const gen = vi.fn().mockResolvedValue({
      object: {
        complete: true,
        confidence: 90,
        findings: [],
        remainingWork: [],
        reasoning: "ok",
      },
      usage: emptyUsage(),
    });
    const ai = makeAi({ generateObject: gen });

    await judgeCompleteness(
      {
        request: "fix add()",
        response: "fixed it",
        filesTouched: ["math_utils.py"],
        commandsRun: ["pytest -q"],
        diff: "--- a/math_utils.py\n+++ b/math_utils.py\n-    return a - b\n+    return a + b",
        commandOutputs: [
          { command: "pytest -q", output: "2 passed in 0.01s", ok: true },
        ],
        steps: 4,
        executorModel: "anthropic/claude-sonnet-5",
      },
      ai,
    );

    const promptArg = (gen.mock.calls[0]?.[0] as { prompt: string }).prompt;
    expect(promptArg).toContain("GIT DIFF");
    expect(promptArg).toContain("return a + b"); // the actual change
    expect(promptArg).toContain("2 passed"); // the test output
    expect(promptArg).toContain("pytest -q");
    expect(promptArg).toContain("exit 0");
  });

  it("marks a command FAILED and preserves the failing tail of its output", async () => {
    const gen = vi.fn().mockResolvedValue({
      object: {
        complete: false,
        confidence: 85,
        findings: ["tests fail"],
        remainingWork: ["fix"],
        reasoning: "failing tests",
      },
      usage: emptyUsage(),
    });
    const ai = makeAi({ generateObject: gen });
    const longOutput =
      "collecting…\n".repeat(500) +
      "E   assert add(2,3)==5\nFAILED test_math.py::test_add";

    await judgeCompleteness(
      {
        request: "fix add()",
        response: "done",
        filesTouched: ["math_utils.py"],
        commandsRun: ["pytest"],
        commandOutputs: [{ command: "pytest", output: longOutput, ok: false }],
        steps: 3,
        executorModel: "anthropic/claude-sonnet-5",
      },
      ai,
    );

    const promptArg = (gen.mock.calls[0]?.[0] as { prompt: string }).prompt;
    expect(promptArg).toContain("FAILED"); // the exit label
    expect(promptArg).toContain("FAILED test_math.py::test_add"); // tail preserved (headTail keeps the end)
  });
});

describe("pickJudgePanel", () => {
  it("returns distinct cross-vendor models, excluding the executor", () => {
    const panel = pickJudgePanel(
      "anthropic/claude-opus-4-8",
      "openai/gpt-5,google/gemini-2.5-pro,anthropic/claude-opus-4-8,openai/gpt-5",
    );
    expect(panel).toContain("openai/gpt-5");
    expect(panel).toContain("google/gemini-2.5-pro");
    expect(panel).not.toContain("anthropic/claude-opus-4-8"); // executor excluded
    expect(new Set(panel).size).toBe(panel.length); // distinct
  });

  it("always yields at least one judge distinct from the executor", () => {
    const panel = pickJudgePanel("openai/gpt-5", "openai/gpt-5");
    expect(panel.length).toBeGreaterThanOrEqual(1);
    expect(panel).not.toContain("openai/gpt-5");
  });
});

describe("judgePanel", () => {
  function judgeAi(perModel: Record<string, boolean>): AgentAi {
    return makeAi({
      generateObject: vi.fn().mockImplementation((args: { model: string }) => {
        const complete = perModel[args.model] ?? true;
        return Promise.resolve({
          object: {
            complete,
            confidence: complete ? 90 : 70,
            findings: complete ? [] : [`${args.model} says: missing tests`],
            remainingWork: complete ? [] : ["add tests"],
            reasoning: complete ? "looks done" : "incomplete",
          },
          usage: emptyUsage(),
        });
      }),
    });
  }
  const base = {
    request: "fix it",
    response: "done",
    filesTouched: ["a.ts"],
    commandsRun: [],
    steps: 2,
    executorModel: "anthropic/claude-opus-4-8",
  };

  it("is complete only on a strict majority; unions dissenting findings otherwise", async () => {
    // 2 of 3 say incomplete → panel INCOMPLETE, findings unioned.
    const ai = judgeAi({
      "openai/gpt-5": false,
      "google/gemini-2.5-pro": false,
      "x/y": true,
    });
    const verdict = await judgePanel(base, ai, [
      "openai/gpt-5",
      "google/gemini-2.5-pro",
      "x/y",
    ]);
    expect(verdict.complete).toBe(false);
    expect(verdict.findings.length).toBeGreaterThanOrEqual(2);
    expect(verdict.model).toContain("panel(");
  });

  it("is complete when a majority agree it's complete", async () => {
    const ai = judgeAi({
      "openai/gpt-5": true,
      "google/gemini-2.5-pro": true,
      "x/y": false,
    });
    const verdict = await judgePanel(base, ai, [
      "openai/gpt-5",
      "google/gemini-2.5-pro",
      "x/y",
    ]);
    expect(verdict.complete).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it("propagates a fatal auth/billing error from any panel member instead of masking it in the vote", async () => {
    // One panel member hits a fatal error; the other two would say "complete".
    // A majority-vote aggregation must NOT silently treat the failure as a
    // dissenting "incomplete" vote and declare the panel complete anyway — that
    // would hide an out-of-credits account behind a falsely reassuring verdict.
    const ai = makeAi({
      generateObject: vi.fn().mockImplementation((args: { model: string }) => {
        if (args.model === "google/gemini-2.5-pro")
          return Promise.reject(FATAL_ERROR);
        return Promise.resolve({
          object: {
            complete: true,
            confidence: 90,
            findings: [],
            remainingWork: [],
            reasoning: "looks done",
          },
          usage: emptyUsage(),
        });
      }),
    });
    await expect(
      judgePanel(base, ai, ["openai/gpt-5", "google/gemini-2.5-pro", "x/y"]),
    ).rejects.toThrow(/positive credit balance/);
  });

  it("delegates to a single judge when the panel has one model", async () => {
    const ai = judgeAi({ "openai/gpt-5": false });
    const verdict = await judgePanel(base, ai, ["openai/gpt-5"]);
    expect(verdict.complete).toBe(false);
    expect(verdict.model).not.toContain("panel("); // single-judge path
  });
});

describe("pickAdvisorModel", () => {
  it("returns default advisor when it differs from executor", () => {
    const m = pickAdvisorModel("anthropic/claude-haiku-4.5");
    expect(m).toBe(DEFAULT_ADVISOR_MODEL);
  });

  it("returns a different model when executor IS the default advisor", () => {
    const m = pickAdvisorModel(DEFAULT_ADVISOR_MODEL);
    expect(m).not.toBe(DEFAULT_ADVISOR_MODEL);
  });
});

// ── buildRevisionPrompt ───────────────────────────────────────────────────────

describe("buildRevisionPrompt", () => {
  it("includes findings and remaining work", () => {
    const prompt = buildRevisionPrompt({
      complete: false,
      confidence: 60,
      findings: ["Missing tests", "No type annotations"],
      remainingWork: ["Add vitest tests", "Add types"],
      reasoning: "Both are missing",
      model: "some/model",
      fallback: false,
      usage: emptyUsage(),
    });

    expect(prompt).toContain("Missing tests");
    expect(prompt).toContain("Add vitest tests");
    expect(prompt).toContain("NOT done");
  });
});

// ── enhancePrompt ─────────────────────────────────────────────────────────────

describe("enhancePrompt", () => {
  it("returns the original prompt when no memory is wired", async () => {
    const result = await enhancePrompt({ prompt: "fix the bug" });
    expect(result.prompt).toBe("fix the bug");
    expect(result.context).toBe("");
    expect(result.hasMemory).toBe(false);
  });

  it("injects memory context when provider returns non-empty string", async () => {
    const memory = {
      recallContext: vi
        .fn()
        .mockResolvedValue("Remember: always run tests after changes"),
      remember: vi.fn(),
    };

    const result = await enhancePrompt({
      prompt: "make a change",
      memory,
    });

    expect(result.hasMemory).toBe(true);
    expect(result.context).toContain("Recalled context");
    expect(result.context).toContain("always run tests");
  });

  it("treats whitespace-only recall as no memory", async () => {
    const memory = {
      recallContext: vi.fn().mockResolvedValue("   \n  "),
      remember: vi.fn(),
    };

    const result = await enhancePrompt({ prompt: "make a change", memory });
    expect(result.hasMemory).toBe(false);
    expect(result.prompt).toBe("make a change");
  });

  it("handles memory provider throwing gracefully", async () => {
    const memory = {
      recallContext: vi.fn().mockRejectedValue(new Error("memory error")),
      remember: vi.fn(),
    };

    const result = await enhancePrompt({ prompt: "test", memory });
    expect(result.hasMemory).toBe(false);
    expect(result.prompt).toBe("test");
  });
});
