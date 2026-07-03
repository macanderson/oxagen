import { describe, it, expect, vi } from "vitest";
import { selectBestCandidate, looksPassing, type Candidate } from "./select";
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
    const ai = makeAi({ generateObject: vi.fn().mockRejectedValue(new Error("gateway down")) });
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
      generateObject: vi.fn().mockRejectedValue(
        new Error("A positive credit balance is required for all requests, please add credits."),
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
});

function emptyUsageLike() {
  return { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
}
