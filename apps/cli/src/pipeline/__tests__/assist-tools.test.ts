/**
 * Group 4 assist tools — prompt_enhancer, judge, user_survey, and the
 * ask-versus-guess decision. Proves the four hard requirements:
 *
 *   1. The enhancer fires below threshold and both start + done are logged.
 *   2. The judge refuses to run on the worker's model.
 *   3. Every survey question includes a free-text option.
 *   4. A best-practice case skips the survey and logs the default.
 *
 * Plus: the pipeline switch turns all three off (logged skips), the config merge
 * layers overrides on defaults, the recommended model is reconciled up for
 * high-stakes prompts, and the survey cap never silently truncates.
 *
 * The debug log, the model call, and the prompter are all mocked/injected, so no
 * gateway, filesystem, or terminal is touched.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { tmpdir } from "node:os";

vi.mock("../../lib/debug-log.js", () => ({ debugLog: vi.fn() }));
// Keep the enhancer hermetic: don't touch the real code graph / fleet memory.
vi.mock("../../agent/prompt-enhancer.js", () => ({
  enhancePrompt: async ({ prompt }: { prompt: string }) => ({
    prompt,
    context: "",
    resolved: [],
    lessons: [],
    startedAt: 0,
    finishedAt: 0,
    durationMs: 0,
    retrieval: { symbolsQueried: [], pathsQueried: [], resolved: [], unresolved: [] },
  }),
}));

import { debugLog } from "../../lib/debug-log.js";
import { runPromptEnhancer } from "../prompt-enhancer.js";
import { runJudge, JudgeSameModelError } from "../judge.js";
import { runSurvey, normalizeQuestions, type SurveyPrompter } from "../survey.js";
import { decideClarification } from "../decide.js";
import { formatToolLine } from "../logging.js";
import {
  mergeAssistConfig,
  resolveJudgeModel,
  DEFAULT_ASSIST_CONFIG,
  DEFAULT_JUDGE_MODEL,
  type AssistPipelineConfig,
} from "../config.js";
import type { SurveyQuestion } from "../types.js";

const mockDebug = debugLog as unknown as Mock;

/** All debug lines emitted so far (the `event` arg of each debugLog call). */
function lines(): string[] {
  return mockDebug.mock.calls.map((c) => c[1] as string);
}
/** True if any emitted line contains every one of the given substrings. */
function loggedLine(...needles: string[]): boolean {
  return lines().some((l) => needles.every((n) => l.includes(n)));
}

function config(overrides: Parameters<typeof mergeAssistConfig>[0] = {}): AssistPipelineConfig {
  return mergeAssistConfig(overrides);
}

const clock = () => {
  let t = 1000;
  return () => (t += 5);
};

beforeEach(() => {
  mockDebug.mockReset();
  process.env["AI_GATEWAY_API_KEY"] = "test-key";
  delete process.env["OXAGEN_LLM_JUDGE"];
});

// ── prompt_enhancer ──────────────────────────────────────────────────────────
describe("runPromptEnhancer", () => {
  it("fires below threshold and logs start + done", async () => {
    const generate = vi.fn().mockResolvedValue({
      object: {
        enhancedPrompt: "Fix the login bug in auth/login.ts",
        complexity: "medium",
        addedContext: ["Impacted file: auth/login.ts"],
        rationale: "Named the file involved.",
      },
      usage: { inputTokens: 40, outputTokens: 60 },
    });

    const out = await runPromptEnhancer(
      { rawPrompt: "fix the login bug", completenessScore: 0.5 },
      { config: config(), cwd: tmpdir(), generate, now: clock() },
    );

    expect(generate).toHaveBeenCalledOnce();
    expect(out.enhancedPrompt).toContain("auth/login.ts");
    expect(out.recommendedModel).toBeTruthy();
    // start line names the completeness gap; done line reports the outcome.
    expect(loggedLine("tool=prompt-enhancer", "status=start", "completeness 0.5 < 0.7")).toBe(true);
    expect(loggedLine("tool=prompt-enhancer", "status=done", "result=enhanced", "tokens=100")).toBe(
      true,
    );
  });

  it("reconciles the recommended model UP for a high-stakes prompt", async () => {
    // The model under-rates a billing change as trivial; the router floor wins.
    const generate = vi.fn().mockResolvedValue({
      object: {
        enhancedPrompt: "…",
        complexity: "trivial",
        addedContext: [],
        rationale: "…",
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const out = await runPromptEnhancer(
      { rawPrompt: "add a refund path to the billing invoice flow", completenessScore: 0.4 },
      { config: config(), cwd: tmpdir(), generate, now: clock() },
    );
    // billing/refund is a precise-tier domain → complexity floored to high.
    expect(["high", "very_high"]).toContain(out.complexity);
  });

  it("skips and logs when the pipeline is off", async () => {
    const generate = vi.fn();
    const out = await runPromptEnhancer(
      { rawPrompt: "do the thing", completenessScore: 0.2 },
      { config: config({ enabled: false }), cwd: tmpdir(), generate },
    );
    expect(generate).not.toHaveBeenCalled();
    expect(out.enhancedPrompt).toBe("do the thing");
    expect(loggedLine("tool=prompt-enhancer", "status=skipped", 'reason="pipeline off"')).toBe(true);
  });
});

// ── judge ────────────────────────────────────────────────────────────────────
describe("runJudge", () => {
  it("refuses to run on the worker's model", async () => {
    await expect(
      runJudge(
        { diff: "…", workerModel: "anthropic/claude-sonnet-4.6", judgeModel: "anthropic/claude-sonnet-4.6" },
        { config: config(), cwd: tmpdir() },
      ),
    ).rejects.toBeInstanceOf(JudgeSameModelError);
  });

  it("evaluates the diff on a distinct judge model and logs start + done", async () => {
    const generate = vi.fn().mockResolvedValue({
      object: { verdict: "fail", score: 0.3, notes: "Tests missing.", gaps: ["No test for the new path"] },
      usage: { inputTokens: 20, outputTokens: 30 },
    });
    const out = await runJudge(
      {
        diff: "diff --git a/x b/x",
        evidence: ["build ok"],
        definitionOfDone: "route + test",
        workerModel: "anthropic/claude-sonnet-4.6",
        judgeModel: "openai/gpt-5.5-pro",
      },
      { config: config(), cwd: tmpdir(), generate, now: clock() },
    );
    expect(out.verdict).toBe("fail");
    expect(loggedLine("tool=judge", "status=start", "worker_model=anthropic/claude-sonnet-4.6", "judge_model=openai/gpt-5.5-pro")).toBe(true);
    expect(loggedLine("tool=judge", "status=done", "verdict=fail", "tokens=50")).toBe(true);
  });

  it("skips and logs when the pipeline is off, without enforcing the model rule", async () => {
    const out = await runJudge(
      { diff: "x", workerModel: "same", judgeModel: "same" },
      { config: config({ enabled: false }), cwd: tmpdir() },
    );
    expect(out.verdict).toBe("pass");
    expect(loggedLine("tool=judge", "status=skipped", 'reason="pipeline off"')).toBe(true);
  });

  it("falls back to a conservative fail on an empty diff when the model is unavailable", async () => {
    delete process.env["AI_GATEWAY_API_KEY"];
    const out = await runJudge(
      { diff: "   ", workerModel: "a", judgeModel: "b" },
      { config: config(), cwd: tmpdir(), now: clock() },
    );
    expect(out.verdict).toBe("fail");
  });
});

// ── user_survey ──────────────────────────────────────────────────────────────
describe("runSurvey", () => {
  it("guarantees a free-text option on every question", () => {
    const questions: SurveyQuestion[] = [
      { id: "a", prompt: "Scope?", options: [{ label: "narrow" }], allowFreeText: false },
      { id: "b", prompt: "UX?", options: [{ label: "modal" }], allowFreeText: false },
    ];
    const { questions: normalized } = normalizeQuestions(questions, DEFAULT_ASSIST_CONFIG.survey);
    expect(normalized.every((q) => q.allowFreeText === true)).toBe(true);
  });

  it("presents free-text-enabled questions and logs answered + free_text_used", async () => {
    const seen: SurveyQuestion[] = [];
    const prompter: SurveyPrompter = {
      ask: async (q) => {
        seen.push(q);
        return { questionId: q.id, value: "my own answer", source: "free_text" };
      },
    };
    const out = await runSurvey(
      {
        reason: "scope is genuinely ambiguous",
        questions: [{ id: "a", prompt: "Scope?", options: [{ label: "narrow" }], allowFreeText: false }],
      },
      { config: config(), prompter },
    );
    expect(seen[0]?.allowFreeText).toBe(true);
    expect(out.answers).toHaveLength(1);
    expect(loggedLine("tool=survey", "status=start", "questions=1")).toBe(true);
    expect(loggedLine("tool=survey", "status=done", "answered=1", "free_text_used=1")).toBe(true);
  });

  it("caps questions at maxQuestions and logs the drop (never silent truncation)", async () => {
    const prompter: SurveyPrompter = {
      ask: async (q) => ({ questionId: q.id, value: q.options[0]?.label ?? "", source: "option" }),
    };
    const many: SurveyQuestion[] = Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`,
      prompt: `Q${i}?`,
      options: [{ label: "x" }],
      allowFreeText: true,
    }));
    const out = await runSurvey({ reason: "r", questions: many }, { config: config(), prompter });
    expect(out.answers).toHaveLength(3);
    expect(loggedLine("tool=survey", "status=start", "dropped=2")).toBe(true);
  });

  it("skips and logs when the pipeline is off", async () => {
    const prompter: SurveyPrompter = { ask: vi.fn() };
    const out = await runSurvey(
      { reason: "r", questions: [{ id: "a", prompt: "?", options: [], allowFreeText: true }] },
      { config: config({ enabled: false }), prompter },
    );
    expect(out.answers).toEqual([]);
    expect(prompter.ask).not.toHaveBeenCalled();
    expect(loggedLine("tool=survey", "status=skipped", 'reason="pipeline off"')).toBe(true);
  });
});

// ── decideClarification (ask vs guess) ───────────────────────────────────────
describe("decideClarification", () => {
  it("skips a best-practice case and logs the default (does not ask)", async () => {
    const d = await decideClarification(
      {
        completenessScore: 0.4,
        recoverableFromContext: false,
        bestPractice: "use RLS-scoped withTenantDb",
      },
      config(),
    );
    expect(d.kind).toBe("default");
    expect(d.reason).toBe("best-practice");
    expect(loggedLine("tool=survey", "status=skipped", "reason=best-practice", "default=")).toBe(true);
  });

  it("enhances (not asks) when the gap is recoverable from context", async () => {
    const d = await decideClarification(
      { completenessScore: 0.3, recoverableFromContext: true },
      config(),
    );
    expect(d.kind).toBe("enhance");
    expect(loggedLine("tool=survey", "status=skipped", "reason=recoverable")).toBe(true);
  });

  it("surveys only for a real developer decision with no default", async () => {
    const d = await decideClarification(
      { completenessScore: 0.3, recoverableFromContext: false },
      config(),
    );
    expect(d.kind).toBe("survey");
  });

  it("proceeds with a default when the developer is unlikely to answer well", async () => {
    const d = await decideClarification(
      {
        completenessScore: 0.3,
        recoverableFromContext: false,
        developerLikelyToAnswerWell: false,
        fallbackDefault: "keep current behavior",
      },
      config(),
    );
    expect(d.kind).toBe("default");
    expect(d.reason).toBe("weak-answer-risk");
    expect(loggedLine("tool=survey", "status=skipped", "reason=weak-answer-risk")).toBe(true);
  });

  it("skips clarification entirely when the prompt is already complete", async () => {
    const d = await decideClarification(
      { completenessScore: 0.95, recoverableFromContext: false },
      config(),
    );
    expect(d.kind).toBe("skip");
    expect(loggedLine("tool=survey", "status=skipped", "reason=already-complete")).toBe(true);
  });
});

// ── config + logging ─────────────────────────────────────────────────────────
describe("assist config + logging", () => {
  it("layers overrides on defaults without dropping unset fields", () => {
    const merged = mergeAssistConfig({ promptEnhancement: { minAcceptableScore: 0.9 } });
    expect(merged.promptEnhancement.minAcceptableScore).toBe(0.9);
    expect(merged.promptEnhancement.enabled).toBe(true); // preserved
    expect(merged.judge.defaultModel).toBe(DEFAULT_JUDGE_MODEL);
    expect(merged.survey.maxQuestions).toBe(3);
  });

  it("resolves the judge model: env > configured > default", () => {
    expect(resolveJudgeModel()).toBe(DEFAULT_JUDGE_MODEL);
    expect(resolveJudgeModel("openai/custom")).toBe("openai/custom");
    process.env["OXAGEN_LLM_JUDGE"] = "openai/override";
    expect(resolveJudgeModel("openai/custom")).toBe("openai/override");
  });

  it("quotes only values with whitespace in the canonical line", () => {
    const line = formatToolLine({ tool: "judge", step: 5, status: "start" }, [
      ["worker_model", "anthropic/claude-sonnet-4.6"],
      ["reason", "qualify diff"],
    ]);
    expect(line).toContain("worker_model=anthropic/claude-sonnet-4.6");
    expect(line).toContain('reason="qualify diff"');
  });
});
