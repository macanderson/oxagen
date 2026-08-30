/**
 * Tests for the engine's evaluate sub-package.
 *
 * Tests evaluatePrompt, judgeCompleteness, buildRevisionPrompt, and
 * extractCandidates via mocked AgentAi ports — never hits the gateway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluatePrompt, LOCAL_EVALUATOR } from "./evaluator";
import {
  judgeCompleteness,
  judgePanel,
  pickJudgePanel,
  buildRevisionPrompt,
  pickAdvisorModel,
  DEFAULT_ADVISOR_MODEL,
} from "./judge";
import { extractCandidates, enhancePrompt } from "./prompt-enhancer";
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
          contextQueries: ["loginUser"],
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
    expect(result.contextQueries).toContain("loginUser");
    expect(result.refinedPrompt).toContain("Fix the login timeout");
    expect(result.fallback).toBe(false);
    expect(result.usage.inputTokens).toBe(100);
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
          contextQueries: [],
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
          contextQueries: [],
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

// ── extractCandidates ─────────────────────────────────────────────────────────

describe("extractCandidates", () => {
  it("extracts backtick symbols", () => {
    const { symbols } = extractCandidates("Fix the `loginUser` function");
    expect(symbols).toContain("loginUser");
  });

  it("extracts backtick paths", () => {
    const { paths } = extractCandidates("The bug is in `src/auth/session.ts`");
    expect(paths).toContain("src/auth/session.ts");
  });

  it("extracts CamelCase identifiers from prose", () => {
    const { symbols } = extractCandidates("The GraphNode component is broken");
    expect(symbols).toContain("GraphNode");
  });

  it("extracts snake_case identifiers from prose", () => {
    const { symbols } = extractCandidates("fix the build_tools script");
    expect(symbols).toContain("build_tools");
  });

  it("deduplicates candidates", () => {
    const { symbols } = extractCandidates("`loginUser` and `loginUser` again");
    expect(symbols.filter((s) => s === "loginUser").length).toBe(1);
  });

  it("returns empty arrays for plain text", () => {
    const { symbols, paths } = extractCandidates("fix the bug please");
    expect(symbols).toHaveLength(0);
    expect(paths).toHaveLength(0);
  });

  it("drops capitalized prose stopwords but keeps real symbols", () => {
    const { symbols } = extractCandidates(
      "Fix the ASCIIUsernameValidator. Replace the regex and Confirm the change. However the FixDecimalInputMixin stays.",
    );
    expect(symbols).toContain("ASCIIUsernameValidator");
    expect(symbols).toContain("FixDecimalInputMixin");
    expect(symbols).not.toContain("Fix");
    expect(symbols).not.toContain("Replace");
    expect(symbols).not.toContain("Confirm");
    expect(symbols).not.toContain("However");
  });

  it("still extracts stopword-shaped tokens when backticked (explicit code quote)", () => {
    const { symbols } = extractCandidates("call `fix` here");
    expect(symbols).toContain("fix");
  });
});

// ── enhancePrompt ─────────────────────────────────────────────────────────────

describe("enhancePrompt", () => {
  // Disable localization (F1) for these tests — they predate the feature
  // and expect specific semantic fallback behavior.
  let originalLocalize: string | undefined;

  beforeEach(() => {
    originalLocalize = process.env.OXAGEN_LOCALIZE;
    process.env.OXAGEN_LOCALIZE = "0";
  });

  afterEach(() => {
    if (originalLocalize === undefined) {
      delete process.env.OXAGEN_LOCALIZE;
    } else {
      process.env.OXAGEN_LOCALIZE = originalLocalize;
    }
  });

  it("bounds the code-graph pass with timeoutMs and degrades to no context", async () => {
    // A provider stuck on a cold build: the query never resolves.
    const codeGraph = { query: vi.fn(() => new Promise<string>(() => {})) };
    const started = Date.now();
    const result = await enhancePrompt({
      prompt: "fix the `loginUser` function in `src/auth/session.ts`",
      codeGraph,
      timeoutMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.context).toBe("");
    expect(result.resolved).toHaveLength(0);
    // The stuck query was abandoned, not rejected — enhancement is best-effort.
    expect(result.prompt).toContain("loginUser");
  });

  it("keeps whatever resolved before the deadline expired", async () => {
    let calls = 0;
    const codeGraph = {
      query: vi.fn((): Promise<string> => {
        calls += 1;
        // First query resolves instantly; later ones hang (budget exhausts).
        return calls === 1
          ? Promise.resolve("src/auth/session.ts:5: loginUser function")
          : new Promise<string>(() => {});
      }),
    };
    const result = await enhancePrompt({
      prompt: "fix `loginUser` and `parseToken` and `refreshSession`",
      codeGraph,
      timeoutMs: 100,
    });
    expect(result.resolved).toContain("loginUser");
    expect(result.context).toContain("loginUser");
  });

  it("returns original prompt when no codeGraph or memory", async () => {
    const result = await enhancePrompt({ prompt: "fix the bug" });
    expect(result.prompt).toBe("fix the bug");
    expect(result.context).toBe("");
    expect(result.resolved).toHaveLength(0);
    expect(result.hasMemory).toBe(false);
  });

  it("injects code graph results for matching symbols", async () => {
    const codeGraph = {
      query: vi
        .fn()
        .mockResolvedValue("src/auth/session.ts:5: loginUser function"),
    };

    const result = await enhancePrompt({
      prompt: "fix the `loginUser` function",
      codeGraph,
    });

    expect(result.context).toContain("loginUser");
    expect(result.resolved).toContain("loginUser");
    expect(result.prompt).toContain("code graph");
  });

  it("skips code graph results that are misses", async () => {
    const codeGraph = {
      query: vi.fn().mockResolvedValue("No symbols matching foo"),
    };

    const result = await enhancePrompt({
      prompt: "fix the `foo` function",
      codeGraph,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.context).toBe("");
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

  it("handles memory provider throwing gracefully", async () => {
    const memory = {
      recallContext: vi.fn().mockRejectedValue(new Error("memory error")),
      remember: vi.fn(),
    };

    const result = await enhancePrompt({ prompt: "test", memory });
    expect(result.hasMemory).toBe(false);
    expect(result.prompt).toBe("test");
  });

  it("handles code graph throwing gracefully", async () => {
    const codeGraph = {
      query: vi.fn().mockRejectedValue(new Error("graph error")),
    };

    const result = await enhancePrompt({
      prompt: "fix `loginUser`",
      codeGraph,
    });

    expect(result.resolved).toHaveLength(0);
    expect(result.prompt).toBe("fix `loginUser`");
  });

  it("uses extraQueries for additional symbol lookups", async () => {
    const codeGraph = {
      query: vi.fn().mockResolvedValue("found: sessionStore definition"),
    };

    const result = await enhancePrompt({
      prompt: "fix the session timeout",
      codeGraph,
      extraQueries: ["sessionStore"],
    });

    expect(result.resolved).toContain("sessionStore");
  });

  it("records retrieval stats", async () => {
    const codeGraph = {
      query: vi.fn().mockResolvedValue("No symbols matching xyz"),
    };

    const result = await enhancePrompt({
      prompt: "fix `xyz`",
      codeGraph,
    });

    expect(result.retrieval.symbolsQueried).toContain("xyz");
    expect(result.retrieval.unresolved).toContain("xyz");
    expect(result.retrieval.resolved).toHaveLength(0);
  });

  it("falls back to semantic_search for a conceptual prompt with zero literal tokens", async () => {
    // "project level configurations for the cli app" names no symbol or path —
    // extractCandidates yields nothing, so without the fallback no context
    // would be injected at all (the exact gap this feature closes).
    const codeGraph = {
      query: vi.fn(async (operation: string) => {
        if (operation === "semantic_search") {
          return "apps/cli/oxagen.config.ts (0.81)\napps/cli/src/lib/config.ts (0.63)";
        }
        return "No symbols matching.";
      }),
    };

    const result = await enhancePrompt({
      prompt: "project level configurations for the cli app",
      codeGraph,
    });

    expect(codeGraph.query).toHaveBeenCalledWith(
      "semantic_search",
      "project level configurations for the cli app",
      expect.any(Number),
    );
    expect(result.usedSemanticFallback).toBe(true);
    expect(result.context).toContain("Semantically relevant files");
    expect(result.context).toContain("oxagen.config.ts");
  });

  it("skips the semantic fallback once literal candidates already resolved enough", async () => {
    const codeGraph = {
      query: vi.fn(async (operation: string, q: string) => {
        if (operation === "search" && q === "loginUser") {
          return "src/auth/session.ts:5: loginUser function";
        }
        if (operation === "file_symbols" && q === "session.ts") {
          return "session.ts:\nfunction loginUser — session.ts:5";
        }
        if (operation === "semantic_search")
          return "should-not-be-used.ts (0.99)";
        return "No symbols matching.";
      }),
    };

    const result = await enhancePrompt({
      prompt:
        "where is `loginUser` defined and what does `session.ts` contain?",
      codeGraph,
    });

    expect(result.usedSemanticFallback).toBe(false);
    expect(result.context).not.toContain("should-not-be-used.ts");
  });

  it("degrades gracefully when the code graph throws on the semantic query", async () => {
    const codeGraph = {
      query: vi.fn(async (operation: string) => {
        if (operation === "semantic_search")
          throw new Error("gateway unavailable");
        return "No symbols matching.";
      }),
    };

    const result = await enhancePrompt({
      prompt: "do something conceptual",
      codeGraph,
    });
    expect(result.usedSemanticFallback).toBe(false);
    expect(result.prompt).toBe("do something conceptual");
  });
});
