#!/usr/bin/env node
// DoD merge check (oxagen #1321) — SCR-003 enforcement.
//
// SCR-003 says an issue closes only when every definition-of-done item is
// satisfied and verified. The task issue template (SCR-003 at L2) makes the
// DoD exist; nothing yet made it *checked*. This module supplies the two pure
// judgements the workflow needs:
//
//   1. Does this PR link an issue at all?
//   2. Does each linked issue's DoD checklist have any unchecked item left?
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

/** Strip fenced code blocks and HTML comments before scanning prose. */
function withoutNonProse(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * Extract the issues a PR body claims to close.
 *
 * Returns `{ owner, repo, number }` records, with owner/repo `null` for
 * same-repo references so the caller can fill in the PR's own repository.
 * Deduplicated, because `Closes #12` twice is one issue, not two.
 */
export function linkedIssues(prBody) {
  if (!prBody) return [];
  const seen = new Map();
  for (const match of withoutNonProse(prBody).matchAll(CLOSING_PATTERN)) {
    const [, owner = null, repo = null, number] = match;
    const key = `${owner ?? ""}/${repo ?? ""}#${number}`;
    if (!seen.has(key)) {
      seen.set(key, { owner, repo, number: Number(number) });
    }
  }
  return [...seen.values()];
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
 * @param pr      `{ body, labels: string[] }`
 * @param issues  Resolved linked issues as `{ ref, body }`, in link order.
 * @returns `{ ok, reasons: string[], waived }`
 */
export function verdict(pr, issues) {
  const labels = pr.labels ?? [];
  if (labels.includes(ESCAPE_HATCH_LABEL)) {
    return { ok: true, waived: true, reasons: [] };
  }

  const links = linkedIssues(pr.body);
  if (links.length === 0) {
    return {
      ok: false,
      waived: false,
      reasons: [
        "This PR links no issue. Add a closing reference (`Closes #123`) to the " +
          `description, or apply the \`${ESCAPE_HATCH_LABEL}\` label if the change is ` +
          "genuinely trivial (SCR-003).",
      ],
    };
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

  return { ok: reasons.length === 0, waived: false, reasons };
}

/**
 * Render the check's conclusion as the comment body a reviewer reads.
 * Pure, so the tests assert on the exact text a human will see.
 */
export function formatVerdict(result) {
  if (result.waived) {
    return `SCR-003 DoD check waived by the \`${ESCAPE_HATCH_LABEL}\` label.`;
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
