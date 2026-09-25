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
// The keyword pattern, the negation window, and the spans GitHub ignores all
// come from `scr-dod-check.mjs`, so the two checks agree on what counts as a
// close and a negated close.

import { pathToFileURL } from "node:url";
import {
  CLOSING_PATTERN,
  isNegated,
  withoutNonProse,
} from "./scr-dod-check.mjs";

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
    const lineStart = clean.lastIndexOf("\n", match.index) + 1;
    const lineEnd = clean.indexOf("\n", match.index);
    const line = clean
      .slice(lineStart, lineEnd === -1 ? clean.length : lineEnd)
      .trim();
    findings.push({ match: match[0], line });
  }
  return findings;
}

/**
 * Check a PR body and its commit messages.
 *
 * `sources` is a list of `{ label, text }`, for example
 * `{ label: "PR body", text: pr.body }` and
 * `{ label: "commit abc1234", text: message }`. Returns `{ ok, findings }`,
 * where each finding carries its source label.
 */
export function checkClosingKeywords(sources) {
  const findings = [];
  for (const { label, text } of sources) {
    for (const finding of findNegatedClosings(text)) {
      findings.push({ source: label, ...finding });
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Render a result as Markdown for a job summary or PR comment. */
export function formatClosingKeywords(result) {
  if (result.ok) return "";
  return [
    "### Negated closing keyword",
    "",
    "GitHub ignores the negation and closes these issues when this change merges:",
    "",
    ...result.findings.map(
      (f) => `- ${f.source}: \`${f.match}\` in "${f.line.replace(/`/g, "'")}"`,
    ),
    "",
    "Rewrite each line so GitHub reads no close. Put the reference in",
    "backticks (`` `#N` ``), or say the PR advances the issue with `Refs #N`.",
    "Fix a commit message by rewording the commit, or by squash-merging with",
    "an edited message.",
  ].join("\n");
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
