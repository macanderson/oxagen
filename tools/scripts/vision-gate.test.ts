import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  COMMENT_MARKER,
  MAX_DIFF_CHARS,
  parseVerdict,
  renderComment,
  shouldFail,
  truncateDiff,
  VERDICTS,
} from "./vision-gate.mjs";

const verdictOf = (v: string) =>
  parseVerdict(
    JSON.stringify({
      verdict: v,
      confidence: 0.9,
      summary: "s",
      reasons: ["r1"],
      drift_flags: v === "drifts" ? ["front-line evals"] : [],
      recommendation: "rec",
    }),
  );

describe("parseVerdict", () => {
  it("parses a clean JSON verdict", () => {
    const v = verdictOf("advances");
    expect(v.verdict).toBe("advances");
    expect(v.confidence).toBe(0.9);
    expect(v.reasons).toEqual(["r1"]);
  });

  it("parses JSON wrapped in code fences and prose", () => {
    const raw =
      'Here you go:\n```json\n{"verdict":"drifts","confidence":0.8,"summary":"x","reasons":[],"drift_flags":["vendor lock-in"],"recommendation":"y"}\n```\nDone.';
    const v = parseVerdict(raw);
    expect(v.verdict).toBe("drifts");
    expect(v.drift_flags).toEqual(["vendor lock-in"]);
  });

  it("returns inconclusive on garbage, unknown verdicts, and non-strings", () => {
    expect(parseVerdict("no json here").verdict).toBe("inconclusive");
    expect(parseVerdict('{"verdict":"amazing"}').verdict).toBe("inconclusive");
    expect(parseVerdict("{broken json").verdict).toBe("inconclusive");
    expect(parseVerdict(undefined).verdict).toBe("inconclusive");
  });

  it("sanitizes malformed field types instead of crashing", () => {
    const v = parseVerdict(
      '{"verdict":"neutral","confidence":"high","reasons":"not-an-array"}',
    );
    expect(v.verdict).toBe("neutral");
    expect(v.confidence).toBe(0);
    expect(v.reasons).toEqual([]);
  });
});

describe("truncateDiff", () => {
  it("passes short diffs through untouched", () => {
    expect(truncateDiff("short", 100)).toBe("short");
  });

  it("truncates long diffs and reports the omission", () => {
    const out = truncateDiff("a".repeat(MAX_DIFF_CHARS + 500));
    expect(out.length).toBeLessThan(MAX_DIFF_CHARS + 200);
    expect(out).toContain("diff truncated: 500 characters omitted");
  });
});

describe("buildPrompt", () => {
  it("embeds the vision doc as the sole rubric and the PR context", () => {
    const p = buildPrompt(
      "THE VISION TEXT",
      { title: "t", body: "b" },
      "1 file changed",
      "diff --git",
    );
    expect(p.system).toContain("THE VISION TEXT");
    expect(p.system).toContain("ONLY rubric");
    for (const v of VERDICTS) expect(p.system).toContain(`"${v}"`);
    expect(p.user).toContain("PR title: t");
    expect(p.user).toContain("diff --git");
  });
});

describe("renderComment", () => {
  it("always embeds the sticky-comment marker and the model id", () => {
    const c = renderComment(verdictOf("neutral"), "anthropic/claude-sonnet-5");
    expect(c).toContain(COMMENT_MARKER);
    expect(c).toContain("anthropic/claude-sonnet-5");
    expect(c).toContain("Neutral");
  });

  it("lists drift flags when drifting", () => {
    const c = renderComment(verdictOf("drifts"), "m");
    expect(c).toContain("Drifts from the vision");
    expect(c).toContain("front-line evals");
  });
});

describe("shouldFail", () => {
  it("never fails outside strict mode", () => {
    expect(shouldFail(verdictOf("drifts"), false)).toBe(false);
  });

  it("fails only on drifts in strict mode", () => {
    expect(shouldFail(verdictOf("drifts"), true)).toBe(true);
    expect(shouldFail(verdictOf("neutral"), true)).toBe(false);
    expect(shouldFail(verdictOf("advances"), true)).toBe(false);
  });
});
