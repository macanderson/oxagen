import { describe, expect, it } from "vitest";
import {
  checkClosingKeywords,
  findNegatedClosings,
  formatClosingKeywords,
} from "./check-closing-keywords.mjs";

describe("findNegatedClosings", () => {
  it("flags the sentence from #3533 that closed P0 #2972", () => {
    expect(findNegatedClosings("This PR does not close #2972.")).toEqual([
      { match: "close #2972", line: "This PR does not close #2972." },
    ]);
  });

  it("flags other negations, cross-repo references, and issue URLs", () => {
    const body = [
      "This never fixes #1.",
      "It won't resolve macanderson/stella#2.",
      "It doesn't close https://github.com/macanderson/oxagen/issues/3.",
    ].join("\n");
    expect(findNegatedClosings(body).map((f) => f.match)).toEqual([
      "fixes #1",
      "resolve macanderson/stella#2",
      "close https://github.com/macanderson/oxagen/issues/3",
    ]);
  });

  it("passes a plain close and a Refs", () => {
    expect(findNegatedClosings("Closes #1\n\nRefs #1")).toEqual([]);
  });

  it("passes a negated reference inside inline code", () => {
    expect(findNegatedClosings("This does not close `#1`.")).toEqual([]);
  });

  it("passes a negated reference inside a code block or HTML comment", () => {
    const body = [
      "```",
      "does not close #1",
      "```",
      "<!-- does not close #2 -->",
    ].join("\n");
    expect(findNegatedClosings(body)).toEqual([]);
  });

  it("passes a real close after an unrelated negation in another clause", () => {
    expect(findNegatedClosings("Not a refactor, closes #7.")).toEqual([]);
  });

  it("returns nothing for an empty or missing text", () => {
    expect(findNegatedClosings("")).toEqual([]);
    expect(findNegatedClosings(null)).toEqual([]);
  });
});

describe("checkClosingKeywords", () => {
  it("fails when a commit message carries the negated close", () => {
    const result = checkClosingKeywords([
      { label: "PR body", text: "Refs #2972" },
      {
        label: "commit abc1234",
        text: "fix: tidy\n\nThis does not close #2972.",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      {
        source: "commit abc1234",
        match: "close #2972",
        line: "This does not close #2972.",
      },
    ]);
  });

  it("passes when no source carries a negated close", () => {
    const result = checkClosingKeywords([
      { label: "PR body", text: "Closes #1" },
      { label: "commit abc1234", text: "fix: tidy\n\nRefs #2" },
    ]);
    expect(result).toEqual({ ok: true, findings: [] });
    expect(formatClosingKeywords(result)).toBe("");
  });
});

describe("formatClosingKeywords", () => {
  it("names each finding and recommends backticks or Refs", () => {
    const text = formatClosingKeywords(
      checkClosingKeywords([
        { label: "PR body", text: "This PR does not close #2972." },
      ]),
    );
    expect(text).toContain(
      'PR body: `close #2972` in "This PR does not close #2972."',
    );
    expect(text).toContain("`Refs #N`");
    expect(text).toContain("backticks");
  });
});
