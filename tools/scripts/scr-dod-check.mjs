#!/usr/bin/env node
// DoD merge check (oxagen #1321) — SCR-003 enforcement.
//
// SCR-003 says an issue closes only when every definition-of-done item is
// satisfied and verified. The task issue template (SCR-003 at L2) makes the
// DoD exist; nothing yet made it *checked*. This module supplies the pure
// judgements the workflow needs:
//
//   1. Does this PR claim to close an issue, only advance one (`Refs #N`,
//      oxagen#2640), or link nothing at all?
//   2. Does the DoD checklist of each issue the PR *claims to close* have
//      any unchecked item left?
//
// A `Refs #N` reference is recorded as "this PR is not orphaned" and never
// gated on `#N`'s DoD, because it does not claim to close it — the org's own
// convention (stella/AGENTS.md, "Closing the issue on merge") is exactly
// that `Refs` "deliberately does not close".
//
// ## Why the check runs on the pull request, not on the close
//
// GitHub closes an issue the moment a PR containing `Closes #N` merges, and no
// webhook can veto that — by the time an `issues: closed` event arrives, the
// close has already happened. So verifying at close time can only ever be
// after-the-fact cleanup. Verifying on the PR inverts it: unchecked DoD boxes
// fail the required check, the merge is blocked, and the close never occurs.
// The `issues: closed` guard in the workflow is the safety net for the manual
// path (someone closing by hand), not the primary mechanism.
//
// ## Why checklist state and not an LLM
//
// A markdown task list is machine-readable — `- [x]` versus `- [ ]`. Asking a
// model whether a DoD "looks satisfied" would make a deterministic, auditable
// gate probabilistic, and would let a confident-sounding paragraph outrank an
// unticked box. Whether the human ticking the box was *honest* is not
// something either approach can check; the box is at least a recorded claim.

import { pathToFileURL } from "node:url";

/**
 * Label that waives the linked-issue requirement.
 *
 * A label rather than a magic string in the PR body: labels are enumerable, so
 * `is:pr label:no-issue` lists every waiver ever used and the escape hatch
 * stays auditable instead of becoming an invisible default.
 */
export const ESCAPE_HATCH_LABEL = "no-issue";

/**
 * The `state_reason` values that close an issue without claiming its DoD was
 * met, so the close guard must not reopen them.
 *
 * Only a close marked `completed` asserts the work was done; those are the
 * closes SCR-003 verifies. The other two decide the work should not happen at
 * all — an obsolete idea or a wrong premise (`not_planned`), or the same work
 * tracked somewhere else (`duplicate`). Demanding a ticked checklist there
 * forces a fake tick for work nobody intends to do, which corrupts the one
 * signal the whole check reads.
 *
 * `duplicate` is here because GitHub added it as a first-class close reason
 * after this guard shipped, and the guard kept exempting `not_planned` alone.
 * So the semantically correct close reopened itself: oxagen#2582 was closed as
 * a duplicate at 10:23:11 on 2026-09-03 and reopened by the guard twelve
 * seconds later, leaving a maintainer the choice of fake-ticking a checklist
 * or mislabelling the reason. The guard's own comment already named a
 * duplicate as a case that should be exempt; only the code disagreed.
 */
export const CLOSE_REASONS_EXEMPT_FROM_DOD = ["not_planned", "duplicate"];

/**
 * Whether a close with this `state_reason` is exempt from DoD verification.
 *
 * Lives here rather than inline in `dod-close-guard.yml` so it can be tested.
 * The `not_planned` check sat in that workflow's `script:` block, where no test
 * reaches it, which is how the `duplicate` gap above survived unnoticed.
 *
 * A missing reason is not exempt: GitHub omits `state_reason` on some older
 * closes, and reading absence as permission would waive the check on exactly
 * the closes nobody described.
 */
export function closeExemptFromDod(stateReason) {
  return CLOSE_REASONS_EXEMPT_FROM_DOD.includes(stateReason);
}

// GitHub's own closing keywords. Matching this exact set — rather than any
// `#123` mention — matters: a PR that merely *references* a related issue is
// not claiming to close it, and must not be judged against its DoD.
const CLOSING_KEYWORDS = [
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
];

const CLOSING_PATTERN = new RegExp(
  // keyword, then an optional `owner/repo` prefix, then `#number`
  String.raw`\b(?:${CLOSING_KEYWORDS.join("|")})\b\s*:?\s+` +
    String.raw`(?:([\w.-]+)/([\w.-]+))?#(\d+)`,
  "gi",
);

// The org's own convention (stella's AGENTS.md, "Closing the issue on
// merge"): `Refs #N` when a PR advances an issue without finishing it. Unlike
// the closing keywords, this is not one GitHub itself recognises — it never
// closes anything — so there is nothing to disambiguate from a real close;
// its only job here is to make "this PR is not orphaned" representable
// without lying about a close (oxagen#2640).
const REFS_KEYWORDS = ["ref", "refs"];

const REFS_PATTERN = new RegExp(
  String.raw`\b(?:${REFS_KEYWORDS.join("|")})\b\s*:?\s+` +
    String.raw`(?:([\w.-]+)/([\w.-]+))?#(\d+)`,
  "gi",
);

// Negation words that flip a closing keyword from a claim into a disclaimer:
// "this PR does not close #412" is not a claim to close #412, the same
// principle `linkedIssues` already applies to a bare "Related to #99"
// mention (oxagen#2636). Only checked in the few words immediately before the
// keyword, and never across a clause boundary (`.`, `,`, `;`, a dash, or a
// newline) — otherwise an unrelated "not" earlier in a sentence with two
// references ("closes #1, but not #2, closes #3") would swallow the second,
// real close along with the first.
//
// This is a judgement about what *this checker* should read as a claim, not
// a claim about GitHub's own keyword parser — GitHub's has no notion of
// negation either, so the exact phrasing this excludes really can still
// close the issue on merge. That is a real hazard, but it is GitHub's
// parser's blind spot to fix, not something this gate can veto from the PR
// side; forcing the PR to satisfy a DoD for an issue it explicitly disclaims
// closing is the bug this excludes.
const NEGATION_WORDS = new Set([
  "not",
  "never",
  "cannot",
  "can't",
  "cant",
  "won't",
  "wont",
  "doesn't",
  "doesnt",
  "didn't",
  "didnt",
  "isn't",
  "isnt",
  "wasn't",
  "wasnt",
  "hasn't",
  "hasnt",
  "haven't",
  "havent",
  "shouldn't",
  "shouldnt",
  "wouldn't",
  "wouldnt",
]);

const NEGATION_WINDOW_WORDS = 4;

/** Whether the text immediately before `matchIndex`, within the current clause, carries a negation. */
function isNegated(text, matchIndex) {
  const before = text.slice(0, matchIndex);
  const clauseStart = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf(","),
    before.lastIndexOf(";"),
    before.lastIndexOf("\n"),
    before.lastIndexOf("—"),
    before.lastIndexOf("-"),
  );
  const clause = before.slice(clauseStart + 1);
  const words = clause
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(-NEGATION_WINDOW_WORDS);
  return words.some((word) =>
    NEGATION_WORDS.has(word.toLowerCase().replace(/[^\w']/g, "")),
  );
}

/** Strip fenced code blocks and HTML comments before scanning prose. */
function withoutNonProse(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** Run a keyword pattern over cleaned prose, dropping negated closing matches. */
function matchesOf(prBody, pattern, { skipNegated }) {
  if (!prBody) return [];
  const clean = withoutNonProse(prBody);
  const seen = new Map();
  for (const match of clean.matchAll(pattern)) {
    if (skipNegated && isNegated(clean, match.index)) continue;
    const [, owner = null, repo = null, number] = match;
    const key = `${owner ?? ""}/${repo ?? ""}#${number}`;
    if (!seen.has(key)) {
      seen.set(key, { owner, repo, number: Number(number) });
    }
  }
  return [...seen.values()];
}

/**
 * Extract the issues a PR body claims to close.
 *
 * Returns `{ owner, repo, number }` records, with owner/repo `null` for
 * same-repo references so the caller can fill in the PR's own repository.
 * Deduplicated, because `Closes #12` twice is one issue, not two. A closing
 * keyword that the surrounding prose negates ("does not close #12") is not a
 * claim to close and is excluded — see `isNegated` above.
 */
export function linkedIssues(prBody) {
  return matchesOf(prBody, CLOSING_PATTERN, { skipNegated: true });
}

/**
 * Extract the issues a PR body advances with `Refs #N` without claiming to
 * close them (oxagen#2640). `Refs` never closes anything on GitHub's side, so
 * unlike `linkedIssues` this does not filter negation — there is no claim
 * here to disclaim.
 */
export function referencedIssues(prBody) {
  return matchesOf(prBody, REFS_PATTERN, { skipNegated: false });
}

/**
 * Read the DoD checklist state out of an issue body.
 *
 * Only the section under a "Definition of done" heading or bold label counts.
 * Scanning the whole body would sweep in unrelated task lists — a Context
 * section listing options, say — and block merges on boxes that were never a
 * DoD. When no such section exists, `present` is false and the caller decides
 * what that means.
 */
export function dodStatus(issueBody) {
  if (!issueBody) return { present: false, checked: 0, unchecked: [] };

  const body = withoutNonProse(issueBody);
  const heading = body.match(/^\s*(?:#{1,6}\s*|\*\*)\s*definition of done\b/im);
  if (!heading) return { present: false, checked: 0, unchecked: [] };

  const after = body.slice(heading.index + heading[0].length);
  // The DoD section ends at the next heading of any level, so a later
  // "### Notes" section's task list is not counted against the DoD.
  const endMatch = after.match(/^\s*#{1,6}\s+\S/m);
  const section = endMatch ? after.slice(0, endMatch.index) : after;

  let checked = 0;
  const unchecked = [];
  for (const line of section.split("\n")) {
    const item = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/);
    if (!item) continue;
    if (item[1] === " ") unchecked.push(item[2].trim());
    else checked += 1;
  }
  return { present: true, checked, unchecked };
}

/**
 * Decide whether a PR satisfies SCR-003.
 *
 * Three states, not two (oxagen#2640): a PR either claims to close an issue
 * (`Closes #N`, gated on that issue's DoD), only advances one (`Refs #N`,
 * recorded but never gated — it is not closing it), or links nothing at all
 * (fails, unless waived). A PR may carry both kinds at once — `Closes #A` and
 * `Refs #B` — in which case only `#A` is checked against its DoD; `#B` is
 * referenced, not enforced.
 *
 * @param pr      `{ body, labels: string[] }`
 * @param issues  Resolved *closing* issues as `{ ref, body }`, in link order
 *                — the caller resolves exactly `linkedIssues(pr.body)`, never
 *                the `Refs`-only set, since those are not judged against a
 *                DoD.
 * @returns `{ ok, reasons: string[], waived, refsOnly }`
 */
export function verdict(pr, issues) {
  const labels = pr.labels ?? [];
  if (labels.includes(ESCAPE_HATCH_LABEL)) {
    return { ok: true, waived: true, refsOnly: false, reasons: [] };
  }

  const links = linkedIssues(pr.body);
  const refs = referencedIssues(pr.body);
  if (links.length === 0 && refs.length === 0) {
    return {
      ok: false,
      waived: false,
      refsOnly: false,
      reasons: [
        "This PR links no issue. Add a closing reference (`Closes #123`) if it " +
          "finishes one, `Refs #123` if it only advances one, or apply the " +
          `\`${ESCAPE_HATCH_LABEL}\` label if the change is genuinely trivial (SCR-003).`,
      ],
    };
  }

  if (links.length === 0) {
    // Refs-only: the PR advances an issue without claiming to close it, so
    // there is no DoD here for SCR-003 to verify — `Refs` deliberately does
    // not close (stella/AGENTS.md, "Closing the issue on merge").
    return { ok: true, waived: false, refsOnly: true, reasons: [] };
  }

  const reasons = [];
  for (const issue of issues) {
    const status = dodStatus(issue.body);
    if (!status.present) {
      reasons.push(
        `${issue.ref} has no "Definition of done" section — refile it with the task ` +
          "template so the close can be verified (SCR-003).",
      );
      continue;
    }
    if (status.unchecked.length > 0) {
      const items = status.unchecked
        .map((item) => `  - [ ] ${item}`)
        .join("\n");
      reasons.push(
        `${issue.ref} has ${status.unchecked.length} unchecked DoD item(s):\n${items}`,
      );
    }
  }

  return { ok: reasons.length === 0, waived: false, refsOnly: false, reasons };
}

/**
 * Render the check's conclusion as the comment body a reviewer reads.
 * Pure, so the tests assert on the exact text a human will see.
 */
export function formatVerdict(result) {
  if (result.waived) {
    return `SCR-003 DoD check waived by the \`${ESCAPE_HATCH_LABEL}\` label.`;
  }
  if (result.refsOnly) {
    return (
      "SCR-003 DoD check passed — this PR only references its issue with `Refs`, " +
      "so it is not gated on that issue's definition of done."
    );
  }
  if (result.ok) {
    return "SCR-003 DoD check passed — every linked issue's definition of done is fully checked.";
  }
  return [
    "**SCR-003 — this PR cannot close its issue yet.**",
    "",
    ...result.reasons.map((reason) => `- ${reason}`),
    "",
    "An issue closes only when every DoD item is satisfied *and verified*. Tick the",
    "boxes once each item is genuinely done, or split the remainder into a new issue",
    "(`triage` label only, SCR-004).",
    "",
    // oxagen#2638: ticking a box on the linked issue fires no pull-request
    // event, so nothing here re-runs on its own — this check only reacts to
    // the PR. Said plainly so the prescribed remedy above is actually
    // complete, rather than leaving a genuinely-done PR stuck on a stale run.
    "Ticking those boxes does not by itself re-run this check — it only reacts to",
    "the pull request. Push any change to the PR afterward (even an empty commit,",
    "`git commit --allow-empty -m 'chore: re-run dod-check'`) to get a fresh run.",
  ].join("\n");
}

// Exercised through the workflow's github-script step in CI; this entry point
// exists so the logic can be run by hand against a body on disk when debugging
// a confusing verdict.
async function main() {
  const { readFileSync } = await import("node:fs");
  const [prPath, ...issuePaths] = process.argv.slice(2);
  if (!prPath) {
    console.error(
      "usage: scr-dod-check.mjs <pr-body-file> [<linked-issue-body-file>...]",
    );
    process.exit(2);
  }
  const result = verdict(
    { body: readFileSync(prPath, "utf8"), labels: [] },
    issuePaths.map((path) => ({ ref: path, body: readFileSync(path, "utf8") })),
  );
  console.log(formatVerdict(result));
  process.exit(result.ok ? 0 : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
