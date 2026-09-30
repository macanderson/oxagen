import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkClosingKeywords,
  findNegatedClosings,
  findRefsCommitConflicts,
  formatClosingKeywords,
  isNegatedInSentence,
  pullRequestSources,
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

  it("flags a negation anywhere earlier in the sentence", () => {
    const found = (text: string) =>
      findNegatedClosings(text).map((f) => f.match);
    expect(found("This does not, by itself, close #12.")).toEqual([
      "close #12",
    ]);
    expect(found("Ships without a migration and fixes #8.")).toEqual([
      "fixes #8",
    ]);
    // A real close that shares a sentence with an unrelated negation fails
    // too. The message tells the author to give the close its own sentence.
    expect(found("Not a refactor, closes #7.")).toEqual(["closes #7"]);
  });

  it("passes a close whose negation sits in an earlier sentence", () => {
    expect(findNegatedClosings("Not a refactor. Closes #7.")).toEqual([]);
    expect(findNegatedClosings("It does not touch the API!\nFixes #7")).toEqual(
      [],
    );
  });

  // #4664 item 24: a period inside a token ended the sentence, so the
  // negation before it was dropped and GitHub closed the issue anyway.
  it("keeps a negation across a period inside a token", () => {
    const found = (text: string) =>
      findNegatedClosings(text).map((f) => f.match);
    expect(found("This does not, in v2.0, close #12.")).toEqual(["close #12"]);
    expect(found("It does not, per example.com, fix #3.")).toEqual(["fix #3"]);
    expect(found("It never, in check-closing-keywords.mjs, resolves #4.")).toEqual(
      ["resolves #4"],
    );
  });

  it("ends a sentence at a mark followed by whitespace or the end", () => {
    const text = "Not a refactor. Closes #7";
    expect(isNegatedInSentence(text, text.indexOf("Closes"))).toBe(false);
    const glued = "Not v1.Closes #7";
    expect(isNegatedInSentence(glued, glued.indexOf("Closes"))).toBe(true);
    const asked = "Does it not work? Fixes #9";
    expect(isNegatedInSentence(asked, asked.indexOf("Fixes"))).toBe(false);
  });

  it("returns nothing for an empty or missing text", () => {
    expect(findNegatedClosings("")).toEqual([]);
    expect(findNegatedClosings(null)).toEqual([]);
  });
});

// dod-check.yml skipped the commit half of the check when listing the
// commits failed, and passed on the description alone. The failure is now
// part of the result, so the check fails and the comment says why.
describe("pullRequestSources", () => {
  it("reads the description, then each commit message", async () => {
    const { sources, commitsError } = await pullRequestSources(
      "Refs #1",
      async () => [
        { sha: "abc1234def", commit: { message: "Closes #1" } },
        { sha: "0123456789", commit: { message: "tidy" } },
      ],
    );
    expect(commitsError).toBeNull();
    expect(sources).toEqual([
      { label: "PR body", text: "Refs #1", kind: "body" },
      { label: "commit abc1234", text: "Closes #1", kind: "commit" },
      { label: "commit 0123456", text: "tidy", kind: "commit" },
    ]);
  });

  it("returns the listing error with the description alone", async () => {
    const { sources, commitsError } = await pullRequestSources(
      "Refs #1",
      async () => {
        throw new Error("API rate limit exceeded");
      },
    );
    expect(commitsError).toBe("API rate limit exceeded");
    expect(sources).toEqual([{ label: "PR body", text: "Refs #1", kind: "body" }]);
  });

  it("fails the check when the commits could not be read", async () => {
    const { sources, commitsError } = await pullRequestSources(
      "Refs #1",
      async () => {
        throw new Error("502 Bad Gateway");
      },
    );
    const result = checkClosingKeywords(sources, { commitsError });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.commitsError).toBe("502 Bad Gateway");
    const text = formatClosingKeywords(result);
    expect(text).toContain("### Commit messages not read");
    expect(text).toContain("502 Bad Gateway");
    expect(text).toContain("Re-run the failed `dod` job");
  });

  it("leaves a clean result unchanged when the commits were read", () => {
    expect(
      checkClosingKeywords(
        [{ label: "PR body", text: "Refs #1", kind: "body" }],
        { commitsError: null },
      ),
    ).toEqual({ ok: true, findings: [], conflicts: [] });
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

  it("reads every issue in a Refs list", () => {
    expect(
      findRefsCommitConflicts("Refs #1, #2 and macanderson/stella#3", [
        commit("Closes #2"),
        commit("Fixes macanderson/stella#3"),
      ]).map((f) => f.match),
    ).toEqual(["Closes #2", "Fixes macanderson/stella#3"]);
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
    expect(text).toContain("give the close its");
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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

// #3680's own witness. #3533 merged with "Refs #2972" in its description and
// "This PR does not close #2972." further down, and GitHub closed P0 #2972
// anyway. The fixture is that description, verbatim from the API.
describe("the body of #3533", () => {
  const body = readFileSync(join(HERE, "fixtures", "pr-3533-body.txt"), "utf8");

  it("fails the check on the negated close, and on nothing else", () => {
    const result = checkClosingKeywords([
      { label: "PR body", text: body, kind: "body" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        source: "PR body",
        match: "close #2972",
        line: expect.stringMatching(/^This PR does not close #2972\./),
      }),
    ]);
  });

  it("passes once the negated sentence is gone, so the Refs line is not the fault", () => {
    const fixed = body.replace("This PR does not close #2972.", "");
    expect(
      checkClosingKeywords([{ label: "PR body", text: fixed, kind: "body" }]),
    ).toEqual({ ok: true, findings: [], conflicts: [] });
  });

  it("fails a commit that closes #2972 while the body only references it", () => {
    const fixed = body.replace("This PR does not close #2972.", "");
    const result = checkClosingKeywords([
      { label: "PR body", text: fixed, kind: "body" },
      { label: "commit e4d9395", text: "fix: scope\n\nCloses #2972", kind: "commit" },
    ]);
    expect(result.conflicts).toEqual([
      expect.objectContaining({ source: "commit e4d9395", match: "Closes #2972" }),
    ]);
  });
});

// #3680 DoD: the check runs on every pull_request event, from a job no
// `paths:` filter can skip, so an edit to the description alone is judged.
describe("dod-check.yml runs the closing-keyword check on every PR event", () => {
  const workflow = readFileSync(
    join(REPO_ROOT, ".github", "workflows", "dod-check.yml"),
    "utf8",
  );
  // The `on:` block: from `on:` to the next top-level key.
  const on = /^on:\n([\s\S]*?)^\S/m.exec(workflow)?.[1] ?? "";

  it("has an on: block with a pull_request trigger", () => {
    expect(on).toMatch(/^ {2}pull_request:/m);
  });

  it("filters the trigger by no path", () => {
    expect(on).not.toMatch(/^\s*paths(-ignore)?\s*:/m);
  });

  it("fires on a description edit", () => {
    const types = /types:\s*\[([^\]]*)\]/.exec(on)?.[1] ?? "";
    expect(types.split(",").map((t) => t.trim())).toEqual(
      expect.arrayContaining(["opened", "edited", "synchronize"]),
    );
  });

  it("imports check-closing-keywords.mjs and hands it the body and every commit", () => {
    expect(workflow).toContain("tools/scripts/check-closing-keywords.mjs");
    expect(workflow).toContain("pullRequestSources(pr.body");
    expect(workflow).toContain("github.rest.pulls.listCommits");
    expect(workflow).toContain("checkClosingKeywords(sources");
  });

  it("fails the check, rather than warning, when the commits cannot be listed", () => {
    expect(workflow).toMatch(
      /checkClosingKeywords\(sources, \{\s*repository: context\.repo, commitsError \}\)/,
    );
    expect(workflow).not.toMatch(/core\.warning\(`Could not list the pull request's commits/);
  });
});
