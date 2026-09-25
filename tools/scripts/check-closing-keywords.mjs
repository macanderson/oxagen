#!/usr/bin/env node
// Negated closing-keyword check (oxagen #3680).
//
// GitHub's closing-keyword parser has no notion of negation. "This PR does not
// close #2972." closes #2972 when the PR merges, exactly as "Closes #2972"
// does. PR #3533 carried that sentence and closed P0 #2972 with the fix still
// unshipped.
//
// `scr-dod-check.mjs` reads the same sentence as a disclaimer and skips it,
// which is right for the DoD gate: the PR does not claim the issue, so the
// issue's checklist should not bind it. That leaves nothing that stops the
// close itself. This module fills that gap. It fails a PR whose body or commit
// messages put a negation before a closing keyword and an issue reference, and
// tells the author how to write the sentence so GitHub reads nothing in it.
//
// It also fails a second shape. An author demotes the description from
// `Closes #N` to `Refs #N` because the PR no longer finishes the issue, but a
// commit on the branch still says `Closes #N`. A squash merge copies the commit
// messages into the commit that lands on main, and GitHub closes the issue from
// there. The edited description changes nothing.
//
// The keyword pattern, the negation window, and the spans GitHub ignores all
// come from `scr-dod-check.mjs`, so the two checks agree on what counts as a
// close and a negated close.

import { pathToFileURL } from "node:url";
import {
  CLOSING_PATTERN,
  isNegated,
  linkedIssues,
  referencedIssues,
  withoutNonProse,
} from "./scr-dod-check.mjs";

/** The trimmed line of `text` that holds `index`. */
function lineAt(text, index) {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}

/**
 * A comparable key for an issue reference. A same-repo reference carries no
 * owner or repo, so `repository` (the PR's own `{ owner, repo }`) fills them
 * in. Without it, `#3` and a URL for issue 3 in the same repo would not match.
 * GitHub matches owner and repo names without case.
 */
function issueKey(owner, repo, number, repository) {
  const o = owner ?? repository.owner ?? "";
  const r = repo ?? repository.repo ?? "";
  return `${o.toLowerCase()}/${r.toLowerCase()}#${number}`;
}

/**
 * Find each negated closing reference in `text`.
 *
 * Returns one `{ match, line }` record per offending reference: `match` is the
 * keyword and reference as written, and `line` is the trimmed line that holds
 * it. Code blocks, inline code, and HTML comments are skipped first, because
 * GitHub does not read closing keywords out of them. That is also the fix the
 * message recommends.
 */
export function findNegatedClosings(text) {
  if (!text) return [];
  const clean = withoutNonProse(text);
  const findings = [];
  for (const match of clean.matchAll(CLOSING_PATTERN)) {
    if (!isNegated(clean, match.index)) continue;
    findings.push({ match: match[0], line: lineAt(clean, match.index) });
  }
  return findings;
}

/**
 * Find each commit that closes an issue the PR body only references.
 *
 * `prBody` is the description. `commits` is a list of `{ label, text }`, one
 * per commit message. `repository` is the PR's own `{ owner, repo }`, used to
 * match a same-repo `#N` against a full reference. An issue is in conflict when the body names it with
 * `Refs` and never closes it, while a commit message carries an unnegated
 * `Closes`, `Fixes`, or `Resolves` for it. Returns one
 * `{ source, match, line }` record per closing reference in a commit.
 *
 * A negated close in a commit is left to `findNegatedClosings`, which already
 * fails it, so one sentence is not reported twice.
 */
export function findRefsCommitConflicts(prBody, commits, repository = {}) {
  const key = (r) => issueKey(r.owner, r.repo, r.number, repository);
  const closed = new Set(linkedIssues(prBody).map(key));
  const refsOnly = new Set(
    referencedIssues(prBody)
      .map(key)
      .filter((key) => !closed.has(key)),
  );
  if (refsOnly.size === 0) return [];

  const findings = [];
  for (const { label, text } of commits) {
    if (!text) continue;
    const clean = withoutNonProse(text);
    for (const match of clean.matchAll(CLOSING_PATTERN)) {
      if (isNegated(clean, match.index)) continue;
      // `CLOSING_PATTERN` fills slots 1 to 3 for `#N` and 4 to 6 for a URL.
      const matchKey = key({
        owner: match[1] ?? match[4],
        repo: match[2] ?? match[5],
        number: Number(match[3] ?? match[6]),
      });
      if (!refsOnly.has(matchKey)) continue;
      findings.push({
        source: label,
        match: match[0],
        line: lineAt(clean, match.index),
      });
    }
  }
  return findings;
}

/**
 * Check a PR body and its commit messages.
 *
 * `sources` is a list of `{ label, text, kind }`, for example
 * `{ label: "PR body", text: pr.body, kind: "body" }` and
 * `{ label: "commit abc1234", text: message, kind: "commit" }`. Every source is
 * checked for a negated close. When a `body` source is present, the `commit`
 * sources are also checked for a close the body demoted to `Refs`, with
 * `repository` (the PR's `{ owner, repo }`) resolving same-repo references.
 * Returns
 * `{ ok, findings, conflicts }`, where each record carries its source label.
 */
export function checkClosingKeywords(sources, { repository } = {}) {
  const findings = [];
  for (const { label, text } of sources) {
    for (const finding of findNegatedClosings(text)) {
      findings.push({ source: label, ...finding });
    }
  }
  const bodies = sources.filter((s) => s.kind === "body");
  const conflicts =
    bodies.length === 0
      ? []
      : findRefsCommitConflicts(
          bodies.map((s) => s.text ?? "").join("\n"),
          sources.filter((s) => s.kind === "commit"),
          repository,
        );
  return {
    ok: findings.length === 0 && conflicts.length === 0,
    findings,
    conflicts,
  };
}

/** Render a result as Markdown for a job summary or PR comment. */
export function formatClosingKeywords(result) {
  if (result.ok) return "";
  const item = (f) =>
    `- ${f.source}: \`${f.match}\` in "${f.line.replace(/`/g, "'")}"`;
  const sections = [];
  if (result.findings.length > 0) {
    sections.push(
      [
        "### Negated closing keyword",
        "",
        "GitHub ignores the negation and closes these issues when this change merges:",
        "",
        ...result.findings.map(item),
        "",
        "Rewrite each line so GitHub reads no close. Put the reference in",
        "backticks (`` `#N` ``), or say the PR advances the issue with `Refs #N`.",
        "Fix a commit message by rewording the commit, or by squash-merging with",
        "an edited message.",
      ].join("\n"),
    );
  }
  if ((result.conflicts ?? []).length > 0) {
    sections.push(
      [
        "### Refs in the description, close in a commit",
        "",
        "The description names these issues only with `Refs`, but a commit",
        "closes them. A squash merge copies the commit messages to main, and",
        "GitHub closes the issue from there:",
        "",
        ...result.conflicts.map(item),
        "",
        "Reword each commit to say `Refs #N`. If the PR does finish the issue,",
        "write `Closes #N` in the description instead.",
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

// Exercised through the dod-check workflow in CI. This entry point checks a
// file on disk by hand: `check-closing-keywords.mjs <file>...`.
async function main() {
  const { readFileSync } = await import("node:fs");
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: check-closing-keywords.mjs <text-file>...");
    process.exit(2);
  }
  const result = checkClosingKeywords(
    paths.map((path) => ({ label: path, text: readFileSync(path, "utf8") })),
  );
  if (!result.ok) console.log(formatClosingKeywords(result));
  process.exit(result.ok ? 0 : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
