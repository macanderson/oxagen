import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  COMMENT_MARKER,
  DOC_DRIFT_QUESTION,
  docDriftAnnotation,
  MAX_DIFF_CHARS,
  parseDocDrift,
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

// The doc-drift question (#3202). The finding below is the third case #3169
// produced: `infra/tools/caddy/Caddyfile.alb` told an operator to set
// `TRUSTED_PROXY_HOP_COUNT=2` after deploy, but that variable turns no ceiling
// on; `TRUSTED_PROXY_CIDRS` does.
const CADDY_CASE = {
  file: "infra/tools/caddy/Caddyfile.alb",
  claim: "After deploy, set TRUSTED_PROXY_HOP_COUNT=2 to turn the IP ceilings on.",
  code: "The ceilings read TRUSTED_PROXY_CIDRS; nothing reads TRUSTED_PROXY_HOP_COUNT.",
};

const withDrift = (verdict: string, drift: unknown) =>
  parseVerdict(
    JSON.stringify({
      verdict,
      confidence: 0.8,
      summary: "s",
      reasons: [],
      drift_flags: [],
      recommendation: "",
      doc_drift: drift,
    }),
  );

describe("the doc-drift question", () => {
  it("asks it in the prompt, apart from the verdict, over docs and infra runbooks", () => {
    const p = buildPrompt("V", { title: "t", body: "b" }, "stat", "diff");
    expect(p.system).toContain(DOC_DRIFT_QUESTION);
    expect(p.system).toContain('"doc_drift"');
    expect(DOC_DRIFT_QUESTION).toContain(
      "claim a control is on while the code",
    );
    // Operator guidance outside docs/capabilities is in scope: the Caddyfile
    // case was the one that would have misled an operator.
    expect(DOC_DRIFT_QUESTION).toContain("infra/**");
    expect(DOC_DRIFT_QUESTION).toContain("Caddyfile");
    expect(DOC_DRIFT_QUESTION).toContain("does not change the verdict");
  });

  it("reads the findings from a reply and keeps the verdict as the model gave it", () => {
    const v = withDrift("neutral", [CADDY_CASE]);
    expect(v.verdict).toBe("neutral");
    expect(v.doc_drift).toEqual([CADDY_CASE]);
  });

  it("reads no finding from a reply without the field, or with a malformed one (negative)", () => {
    expect(verdictOf("neutral").doc_drift).toEqual([]);
    expect(withDrift("neutral", "the Caddyfile is wrong").doc_drift).toEqual(
      [],
    );
    expect(
      parseDocDrift([null, 3, { file: "a.md", claim: "  " }, { code: "x" }]),
    ).toEqual([]);
    expect(parseVerdict("no json").doc_drift).toEqual([]);
  });

  it("warns in the comment, naming the file, the claim and what the code does", () => {
    const c = renderComment(withDrift("neutral", [CADDY_CASE]), "m");
    expect(c).toContain("Doc drift (advisory)");
    expect(c).toContain("`infra/tools/caddy/Caddyfile.alb`");
    expect(c).toContain(CADDY_CASE.claim);
    expect(c).toContain(CADDY_CASE.code);
    expect(renderComment(verdictOf("neutral"), "m")).not.toContain(
      "Doc drift",
    );
  });

  it("annotates each finding as a warning on one line", () => {
    const line = docDriftAnnotation({
      ...CADDY_CASE,
      claim: "two\nlines at 100%",
    });
    expect(line.startsWith("::warning title=Vision Gate doc drift::")).toBe(
      true,
    );
    expect(line).toContain("infra/tools/caddy/Caddyfile.alb: two%0Alines at 100%25");
    expect(line).not.toContain("\n");
  });

  it("never fails the build on doc drift, in strict mode or out of it", () => {
    for (const verdict of ["neutral", "advances"]) {
      const v = withDrift(verdict, [CADDY_CASE]);
      expect(shouldFail(v, true)).toBe(false);
      expect(shouldFail(v, false)).toBe(false);
    }
  });
});
