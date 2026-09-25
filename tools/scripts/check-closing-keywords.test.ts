import { describe, expect, it } from "vitest";
import {
  checkClosingKeywords,
  findNegatedClosings,
  findRefsCommitConflicts,
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
    expect(result).toEqual({ ok: true, findings: [], conflicts: [] });
    expect(formatClosingKeywords(result)).toBe("");
  });

  it("fails when the body says Refs and a commit still says Closes", () => {
    const result = checkClosingKeywords([
      { label: "PR body", text: "Refs #3680", kind: "body" },
      {
        label: "commit abc1234",
        text: "fix(ci): guard\n\nCloses #3680",
        kind: "commit",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.conflicts).toEqual([
      { source: "commit abc1234", match: "Closes #3680", line: "Closes #3680" },
    ]);
  });

  it("skips the Refs conflict check when no source is marked as the body", () => {
    const result = checkClosingKeywords([
      { label: "a.txt", text: "Refs #1" },
      { label: "b.txt", text: "Closes #1" },
    ]);
    expect(result).toEqual({ ok: true, findings: [], conflicts: [] });
  });
});

describe("findRefsCommitConflicts", () => {
  const commit = (text: string) => ({ label: "commit abc1234", text });

  it("flags Closes, Fixes, and Resolves in a commit for a Refs-only issue", () => {
    const found = findRefsCommitConflicts(
      "Refs #1, refs #2, and Refs #3.",
      [
        commit("Closes #1"),
        commit("fix: tidy\n\nFixes #2"),
        commit("Resolves https://github.com/macanderson/oxagen/issues/3"),
      ],
      { owner: "macanderson", repo: "oxagen" },
    );
    expect(found.map((f) => f.match)).toEqual([
      "Closes #1",
      "Fixes #2",
      "Resolves https://github.com/macanderson/oxagen/issues/3",
    ]);
  });

  it("passes when the commit only refs the issue too", () => {
    expect(findRefsCommitConflicts("Refs #1", [commit("Refs #1")])).toEqual([]);
  });

  it("passes when the body closes the issue as well as the commit", () => {
    expect(
      findRefsCommitConflicts("Closes #1\n\nRefs #1", [commit("Closes #1")]),
    ).toEqual([]);
  });

  it("passes a commit that closes an issue the body does not name", () => {
    expect(findRefsCommitConflicts("Refs #1", [commit("Closes #2")])).toEqual(
      [],
    );
  });

  it("passes a commit whose close sits in backticks or is negated", () => {
    expect(
      findRefsCommitConflicts("Refs #1", [
        commit("Mentions `Closes #1` as an example."),
        commit("This does not close #1."),
      ]),
    ).toEqual([]);
  });

  it("does not match a same-repo Refs to another repo's issue", () => {
    expect(
      findRefsCommitConflicts(
        "Refs #3",
        [commit("Closes macanderson/stella#3")],
        {
          owner: "macanderson",
          repo: "oxagen",
        },
      ),
    ).toEqual([]);
  });

  it("matches owner and repo without case", () => {
    expect(
      findRefsCommitConflicts("Refs Macanderson/Stella#9", [
        commit("Closes macanderson/stella#9"),
      ]).map((f) => f.match),
    ).toEqual(["Closes macanderson/stella#9"]);
  });

  it("returns nothing for a missing body", () => {
    expect(findRefsCommitConflicts(null, [commit("Closes #1")])).toEqual([]);
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
    expect(text).not.toContain("Refs in the description");
  });

  it("names a commit that closes an issue the body only references", () => {
    const text = formatClosingKeywords(
      checkClosingKeywords([
        { label: "PR body", text: "Refs #7", kind: "body" },
        { label: "commit abc1234", text: "Fixes #7", kind: "commit" },
      ]),
    );
    expect(text).toContain("### Refs in the description, close in a commit");
    expect(text).toContain('commit abc1234: `Fixes #7` in "Fixes #7"');
    expect(text).not.toContain("### Negated closing keyword");
  });
});
