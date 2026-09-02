import { describe, it, expect, vi, afterEach } from "vitest";
import {
  selectBestCandidate,
  looksPassing,
  DEFAULT_SELECTOR_MODEL,
  type Candidate,
} from "./select";
import type { AgentAi } from "../ports";

function makeAi(overrides: Partial<AgentAi> = {}): AgentAi {
  return {
    stream: vi.fn() as AgentAi["stream"],
    generateObject: vi.fn() as AgentAi["generateObject"],
    ...overrides,
  };
}

const cand = (id: string, o: Partial<Candidate> = {}): Candidate => ({
  id,
  model: "anthropic/claude-fable-5",
  diff: "--- a/x\n+++ b/x\n+fix",
  summary: "fixed it",
  changedFiles: ["x.py"],
  steps: 3,
  ...o,
});

describe("looksPassing", () => {
  it("is true for clean output and false when failures appear", () => {
    expect(looksPassing("2 passed in 0.1s")).toBe(true);
    expect(looksPassing("E   assert 1==2\nFAILED test_x.py")).toBe(false);
    expect(looksPassing("Traceback (most recent call last)")).toBe(false);
    expect(looksPassing(undefined)).toBe(false);
  });
});

describe("selectBestCandidate", () => {
  it("returns null winner when no candidate is viable", async () => {
    const ai = makeAi();
    const res = await selectBestCandidate({
      request: "fix",
      candidates: [cand("c1", { failed: true }), cand("c2", { diff: "  " })],
      ai,
    });
    expect(res.winnerId).toBeNull();
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  it("picks the sole viable candidate without a model call", async () => {
    const ai = makeAi();
    const res = await selectBestCandidate({
      request: "fix",
      candidates: [cand("c1"), cand("c2", { failed: true })],
      ai,
    });
    expect(res.winnerId).toBe("c1");
    expect(res.fallback).toBe(true);
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  it("comparatively judges multiple viable candidates and returns the model's winner", async () => {
    const gen = vi.fn().mockResolvedValue({
      object: {
        winnerId: "c2",
        reasoning: "c2's tests pass and the diff is minimal.",
        ranking: [
          { id: "c2", score: 95, note: "tests pass" },
          { id: "c1", score: 60, note: "tests fail" },
        ],
      },
      usage: emptyUsageLike(),
    });
    const ai = makeAi({ generateObject: gen });
    const res = await selectBestCandidate({
      request: "fix add()",
      candidates: [
        cand("c1", { testOutput: "FAILED test_math.py::test_add" }),
        cand("c2", { testOutput: "2 passed in 0.01s" }),
      ],
      ai,
    });
    expect(res.winnerId).toBe("c2");
    expect(res.fallback).toBe(false);
    // The evidence (diffs + test output) reached the selector prompt.
    const prompt = (gen.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("2 passed");
    expect(prompt).toContain("FAILED test_math.py");
  });

  it("guards against the model naming a candidate outside the viable set", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockResolvedValue({
        object: {
          winnerId: "bogus",
          reasoning: "x",
          ranking: [
            { id: "c1", score: 80, note: "ok" },
            { id: "c2", score: 50, note: "meh" },
          ],
        },
        usage: emptyUsageLike(),
      }),
    });
    const res = await selectBestCandidate({
      request: "fix",
      candidates: [cand("c1"), cand("c2")],
      ai,
    });
    // Falls back to the highest-ranked *valid* candidate.
    expect(res.winnerId).toBe("c1");
  });

  it("falls back to a heuristic (tests-pass wins) when the selector model errors", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockRejectedValue(new Error("gateway down")),
    });
    const res = await selectBestCandidate({
      request: "fix",
      candidates: [
        cand("c1", { testOutput: "FAILED", changedFiles: ["a.py"] }),
        cand("c2", { testOutput: "3 passed", changedFiles: ["a.py"] }),
      ],
      ai,
    });
    expect(res.fallback).toBe(true);
    expect(res.winnerId).toBe("c2"); // the passing one
  });

  it("re-throws instead of falling back when the selector hits a fatal auth/billing error", async () => {
    // Every other candidate's selector call would fail identically, so a
    // heuristic fallback here would just mask the real (unrecoverable) error.
    const ai = makeAi({
      generateObject: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "A positive credit balance is required for all requests, please add credits.",
          ),
        ),
    });
    await expect(
      selectBestCandidate({
        request: "fix",
        candidates: [
          cand("c1", { testOutput: "FAILED", changedFiles: ["a.py"] }),
          cand("c2", { testOutput: "3 passed", changedFiles: ["a.py"] }),
        ],
        ai,
      }),
    ).rejects.toThrow(/positive credit balance/);
  });

  it("uses DEFAULT_SELECTOR_MODEL (Fable 5) when no selectorModel or env override is set", async () => {
    const gen = vi.fn().mockResolvedValue({
      object: {
        winnerId: "c1",
        reasoning: "x",
        ranking: [
          { id: "c1", score: 90, note: "ok" },
          { id: "c2", score: 10, note: "meh" },
        ],
      },
      usage: emptyUsageLike(),
    });
    const ai = makeAi({ generateObject: gen });
    const res = await selectBestCandidate({
      request: "fix",
      candidates: [cand("c1"), cand("c2")],
      ai,
    });
    expect(res.model).toBe(DEFAULT_SELECTOR_MODEL);
    expect(res.model).toBe("anthropic/claude-fable-5");
    expect((gen.mock.calls[0]![0] as { model: string }).model).toBe(
      "anthropic/claude-fable-5",
    );
  });

  describe("OXAGEN_LLM_SELECTOR override", () => {
    afterEach(() => {
      delete process.env["OXAGEN_LLM_SELECTOR"];
    });

    it("uses OXAGEN_LLM_SELECTOR when no explicit selectorModel is given", async () => {
      process.env["OXAGEN_LLM_SELECTOR"] = "openai/gpt-5.5-pro";
      const gen = vi.fn().mockResolvedValue({
        object: {
          winnerId: "c1",
          reasoning: "x",
          ranking: [
            { id: "c1", score: 90, note: "ok" },
            { id: "c2", score: 10, note: "meh" },
          ],
        },
        usage: emptyUsageLike(),
      });
      const ai = makeAi({ generateObject: gen });
      const res = await selectBestCandidate({
        request: "fix",
        candidates: [cand("c1"), cand("c2")],
        ai,
      });
      expect(res.model).toBe("openai/gpt-5.5-pro");
    });

    it("an explicit selectorModel wins over OXAGEN_LLM_SELECTOR", async () => {
      process.env["OXAGEN_LLM_SELECTOR"] = "openai/gpt-5.5-pro";
      const gen = vi.fn().mockResolvedValue({
        object: {
          winnerId: "c1",
          reasoning: "x",
          ranking: [
            { id: "c1", score: 90, note: "ok" },
            { id: "c2", score: 10, note: "meh" },
          ],
        },
        usage: emptyUsageLike(),
      });
      const ai = makeAi({ generateObject: gen });
      const res = await selectBestCandidate({
        request: "fix",
        candidates: [cand("c1"), cand("c2")],
        ai,
        selectorModel: "google/gemini-2.5-pro",
      });
      expect(res.model).toBe("google/gemini-2.5-pro");
    });
  });
});

describe("testsPassed — verified evidence beats sniffed testOutput text", () => {
  it("the heuristic fallback prefers a verified-passing candidate even when its testOutput text reads ambiguous", async () => {
    const ai = makeAi({
      generateObject: vi.fn().mockRejectedValue(new Error("gateway down")),
    });
    const res = await selectBestCandidate({
      request: "fix",
      candidates: [
        // Text alone would look like a pass (no "fail"/"error" keywords) but
        // verifyAuto's real exit code says it failed.
        cand("c1", {
          testOutput: "ran 3 cases, 1 broke",
          testsPassed: false,
          changedFiles: ["a.py"],
        }),
        cand("c2", {
          testOutput: "ran 3 cases",
          testsPassed: true,
          changedFiles: ["a.py"],
        }),
      ],
      ai,
    });
    expect(res.fallback).toBe(true);
    expect(res.winnerId).toBe("c2");
  });

  it("candidateBlock spells out VERIFIED PASSING/FAILING so the model sees decisive evidence, not just raw text", async () => {
    const gen = vi.fn().mockResolvedValue({
      object: {
        winnerId: "c2",
        reasoning: "c2 verified passing",
        ranking: [
          { id: "c2", score: 95, note: "verified" },
          { id: "c1", score: 20, note: "verified failing" },
        ],
      },
      usage: emptyUsageLike(),
    });
    const ai = makeAi({ generateObject: gen });
    await selectBestCandidate({
      request: "fix add()",
      candidates: [
        cand("c1", { testOutput: "2 passed", testsPassed: false }), // text says pass, verified says fail
        cand("c2", { testOutput: "2 passed", testsPassed: true }),
      ],
      ai,
    });
    const prompt = (gen.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("VERIFIED FAILING");
    expect(prompt).toContain("VERIFIED PASSING");
  });
});

function emptyUsageLike() {
  return { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
}
