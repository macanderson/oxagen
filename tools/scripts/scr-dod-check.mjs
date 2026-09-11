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
 * Label for a substantial PR that deliberately closes no issue.
 *
 * `no-issue` says *this change is trivial*. A large one that closes nothing —
 * an audit, a mechanical refactor, a sweep that FILES issues rather than
 * closing them — could claim neither that nor a `Closes #N` without saying
 * something untrue, so it stayed red on a real and valid PR. #1941 changed
 * 3,285 files, filed about 1,020 issues, closed none, and sat red on `dod`
 * alone while every other check passed; two automated passes stopped at it
 * rather than pick a false label (#2551).
 *
 * A second label rather than widening `no-issue`, because the two are
 * different claims and a reviewer should be able to tell them apart at a
 * glance: one says the change is too small to need an issue, the other says it
 * is large and closes none.
 */
export const CLOSES_NOTHING_LABEL = "closes-nothing";

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
  String.raw`\b(?:${CLOSING_KEYWORDS.join("|")})\b\s*:?\s+` +
    // Either the short form — an optional `owner/repo` prefix then `#number` —
    // or the full issue URL. GitHub honours both, and until the URL arm existed
    // this gate saw only the first: a pull request written as
    // `Closes https://github.com/owner/repo/issues/7` closed the issue on merge
    // while the definition-of-done check found nothing to verify and passed.
    // A control that a supported spelling walks straight past is not a control,
    // and this is the spelling GitHub's own UI produces when someone pastes a
    // link.
    String.raw`(?:` +
    String.raw`(?:([\w.-]+)/([\w.-]+))?#(\d+)` +
    String.raw`|https?://(?:www\.)?github\.com/([\w.-]+)/([\w.-]+)/issues/(\d+)` +
    String.raw`)`,
  "gi",
);

/**
 * Normalise one `CLOSING_PATTERN` match to `{ owner, repo, number }`.
 *
 * The two arms fill different capture slots — 1–3 for the `#N` form, 4–6 for
 * the URL form — so a caller reading fixed indexes would silently see `null`
 * for every URL match. Kept beside the pattern so the two cannot drift.
 */
function closingMatchParts(match) {
  const [, shortOwner, shortRepo, shortNumber, urlOwner, urlRepo, urlNumber] =
    match;
  return shortNumber !== undefined
    ? {
        owner: shortOwner ?? null,
        repo: shortRepo ?? null,
        number: shortNumber,
      }
    : { owner: urlOwner ?? null, repo: urlRepo ?? null, number: urlNumber };
}

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

/**
 * Strip the spans GitHub does not read closing keywords out of, before
 * scanning prose: fenced code blocks, HTML comments, and inline code spans.
 *
 * Inline code was the omission, and it cost a real merge. PR #2844's only
 * close-claim was `## `Closes #2648`` — a keyword inside backticks in a
 * heading. GitHub ignored it, so #2648 stayed open when that PR merged; this
 * gate did not, and demanded a ticked checklist for an issue the merge was
 * never going to close.
 *
 * That asymmetry is the worst kind for a gate to have. It blocks work over a
 * close that will not happen, and the obvious way out — ticking boxes to get
 * green — records a verification nobody performed, which is exactly what
 * SCR-003 exists to prevent. Matching GitHub's own reading is the only way the
 * gate's answer means what it says.
 *
 * Double-backtick spans are stripped before single, so a ``literal ` inside``
 * span is not mistaken for two single-backtick spans with prose between them.
 */
function withoutNonProse(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/``[^`]*``/g, "")
    .replace(/`[^`\n]*`/g, "");
}

/** Run a keyword pattern over cleaned prose, dropping negated closing matches. */
function matchesOf(prBody, pattern, { skipNegated }) {
  if (!prBody) return [];
  const clean = withoutNonProse(prBody);
  const seen = new Map();
  for (const match of clean.matchAll(pattern)) {
    if (skipNegated && isNegated(clean, match.index)) continue;
    // `CLOSING_PATTERN` has two arms filling different capture slots, so the
    // parts are read by name rather than by fixed index. `REFS_PATTERN` has one
    // arm and falls through to the same first three slots.
    const { owner, repo, number } = closingMatchParts(match);
    if (number === undefined) continue;
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
 * Does `prBody` name this exact issue, either as a close or as a `Refs`?
 *
 * Lives here rather than inline in `dod-recheck.yml` for the reason
 * `closeExemptFromDod` does: a workflow's `script:` block is reachable by no
 * test, and this predicate decides whether a stale red check ever gets
 * re-run — a wrong answer here is a workflow that runs and does nothing.
 *
 * It is the shape that made that a real risk. `linkedIssues` and
 * `referencedIssues` return `{ owner, repo, number }` records, not numbers, so
 * comparing a list of them against an issue number matches nothing and fails
 * silently. Same-repo references carry `null` for owner/repo, which is why the
 * caller's repository is filled in before comparing (#2638).
 */
export function referencesIssue(prBody, { owner, repo, number }) {
  return [...linkedIssues(prBody), ...referencedIssues(prBody)].some(
    (ref) =>
      ref.number === number &&
      (ref.owner ?? owner) === owner &&
      (ref.repo ?? repo) === repo,
  );
}

/**
 * Headings this corpus writes its done conditions under (oxagen#1407).
 *
 * The template teaches one spelling; the gate reads the ones already in the
 * tracker. Recognising only `Definition of done` made every pre-template issue
 * a migration, and the migration was invisible until someone opened a PR
 * against an old issue and got a red check for a reason unrelated to their
 * change — a per-issue tax paid at the worst moment, by whoever happened to be
 * closing it. A census of macanderson/stella's open non-epic issues found 36
 * under `Done when`, 11 under `What "done" looks like`, and a further 60 under
 * `Done means` that had already been migrated by hand (macanderson/stella#5193).
 *
 * Bare `Done` is deliberately **excluded**. It is short enough to head a
 * section written for another purpose, and the cost of the two directions is
 * not symmetric: a wrongly-recognised section makes this gate read some other
 * checklist as the definition of done, which is the "a measurement that did not
 * happen reads as success" failure the gate exists to prevent. Leaving those
 * issues to fail loudly costs their closer one edit, and `verdict` now tells
 * them exactly which edit to make.
 *
 * Anchored to a heading or a bold label, so a mention of the phrase in prose is
 * not a section.
 */
const DOD_HEADING = new RegExp(
  String.raw`^\s*(?:#{1,6}\s*|\*\*)\s*` +
    String.raw`(?:definition of done|done means|done when|what ["']?done["']? looks like)\b`,
  "gim",
);

/** The `##`/`**` run in front of a heading, stripped to get its text. */
const HEADING_PREFIX = /^\s*(?:#{1,6}\s*|\*\*)\s*/;

/**
 * Read the DoD checklist state out of an issue body.
 *
 * Only the section under one of `DOD_HEADING`'s spellings counts. Scanning the
 * whole body would sweep in unrelated task lists — a Context section listing
 * options, say — and block merges on boxes that were never a DoD.
 *
 * `present` requires **both** a recognised heading and at least one `- [ ]`
 * item under it. A section with no checkboxes is a paragraph, and `verdict`
 * passes on `unchecked.length === 0`, so counting it as present would make the
 * gate unfailable for exactly the issues whose conditions were written as
 * prose. That hole predates the widened heading set — a canonical
 * `## Definition of done` followed by plain bullets already passed verifying
 * nothing — and widening the headings without closing it would have opened it
 * to the whole `Done when` cohort at once.
 *
 * `heading` reports the matched heading text, or `null` when no recognised
 * heading was found at all. The two absences need different remedies, so the
 * caller must be able to tell "no section" from "a section with no boxes".
 *
 * **Every** recognised section is read, not just the first. Widening the
 * heading set means one issue can now carry two of them, and a hand migration
 * is what produces that: stella#5193 moved 60 issues onto the canonical
 * heading, and leaving the old prose section above the new checklist is the
 * ordinary result. Stopping at the first heading would fail such an issue —
 * the legacy section holds no boxes — even though its ticked checklist sits
 * directly below, which is the "red for a reason unrelated to the diff"
 * failure this whole change exists to remove.
 *
 * Aggregating is also the conservative direction. Reading every checklist can
 * only add unchecked items, never hide one, so no arrangement of sections can
 * make the gate pass an issue that a single-section read would have failed. A
 * checkbox is counted once even when sections overlap, because a bold label
 * does not close the `##` section containing it.
 */
export function dodStatus(issueBody) {
  const absent = { present: false, heading: null, checked: 0, unchecked: [] };
  if (!issueBody) return absent;

  const body = withoutNonProse(issueBody);

  let firstHeading = null;
  let checklistHeading = null;
  let checked = 0;
  const unchecked = [];
  const counted = new Set();

  for (const heading of body.matchAll(DOD_HEADING)) {
    const label = heading[0].replace(HEADING_PREFIX, "").trim();
    if (firstHeading === null) firstHeading = label;

    const start = heading.index + heading[0].length;
    const after = body.slice(start);
    // The DoD section ends at the next heading of any level, so a later
    // "### Notes" section's task list is not counted against the DoD.
    const endMatch = after.match(/^\s*#{1,6}\s+\S/m);
    const section = endMatch ? after.slice(0, endMatch.index) : after;

    let offset = start;
    for (const line of section.split("\n")) {
      const at = offset;
      offset += line.length + 1;
      const item = line.match(/^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/);
      if (!item || counted.has(at)) continue;
      counted.add(at);
      if (checklistHeading === null) checklistHeading = label;
      if (item[1] === " ") unchecked.push(item[2].trim());
      else checked += 1;
    }
  }

  if (firstHeading === null) return absent;
  if (checked === 0 && unchecked.length === 0) {
    return { present: false, heading: firstHeading, checked: 0, unchecked: [] };
  }
  return { present: true, heading: checklistHeading, checked, unchecked };
}

/**
 * Say what edit an issue needs before its close can be verified (oxagen#1400).
 *
 * The old text said "refile it with the task template", which, read literally,
 * means close this issue and open a new one — applied to an issue with
 * comments, cross-references, a parent epic and a `Closes` link from the very
 * PR being blocked, that destroys the thing the gate protects. It was also the
 * *only* instruction given, so the message named the one remedy that must not
 * be taken and omitted the one that should.
 *
 * This check is nearly always the only red on an otherwise green PR, failing
 * for a reason unrelated to the diff, and it is read by someone who has never
 * seen it before. The message is the whole interface of the gate, so it names
 * the edit and where to make it.
 *
 * `heading` is the recognised heading found without checkboxes, or `null` when
 * no done-conditions section was found at all. The two have different fixes.
 */
function missingDodReason(ref, heading) {
  if (heading) {
    return (
      `${ref} has a "${heading}" section, but nothing in it is a checkbox — ` +
      "so there is no state for this gate to read.\n" +
      "  Edit the ISSUE (not this PR) and rewrite that section's bullets as " +
      "`- [ ]` items stating the conditions this close must satisfy, then tick " +
      "the ones that are genuinely done. Keep the prose around them.\n" +
      "  Do NOT close and reopen the issue — its history, links and parent are " +
      "the point."
    );
  }
  return (
    `${ref} states no done conditions this gate can read.\n` +
    "  Edit the ISSUE (not this PR): add a `## Definition of done` heading " +
    "followed by `- [ ]` boxes stating the conditions this close must satisfy, " +
    "then tick them.\n" +
    "  If the issue already has a done-conditions paragraph under some other " +
    "heading, convert that paragraph into boxes under one of the headings this " +
    "gate reads — `Definition of done`, `Done means`, `Done when`, " +
    '`What "done" looks like` — and keep the prose.\n' +
    "  Do NOT close and reopen the issue — its history, links and parent are " +
    "the point."
  );
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
  const waiver = [ESCAPE_HATCH_LABEL, CLOSES_NOTHING_LABEL].find((label) =>
    labels.includes(label),
  );

  const links = linkedIssues(pr.body);
  const refs = referencedIssues(pr.body);

  // A waiver is a claim that this PR closes nothing, so it waives only when
  // that is true. Applied before the body was parsed, the label short-circuited
  // everything — a PR carrying `Closes #N` AND a waiver skipped its issue's DoD
  // entirely, which is a way past the gate rather than an exit from it. Found
  // by Sourcery on #2742; `no-issue` had the same hole and is fixed with it,
  // since no open PR combines the two.
  if (waiver) {
    if (links.length === 0) {
      return {
        ok: true,
        waived: true,
        waivedBy: waiver,
        refsOnly: false,
        reasons: [],
      };
    }
    return {
      ok: false,
      waived: false,
      waivedBy: waiver,
      refsOnly: false,
      reasons: [
        `This PR carries the \`${waiver}\` label but its description closes ` +
          `${links.map((l) => l.ref ?? `#${l.number}`).join(", ")}. The label ` +
          "says the PR closes no issue; the body says otherwise. Drop whichever " +
          "one is wrong (SCR-003).",
      ],
    };
  }
  if (links.length === 0 && refs.length === 0) {
    return {
      ok: false,
      waived: false,
      refsOnly: false,
      reasons: [
        "This PR links no issue. Add a closing reference (`Closes #123`) if it " +
          "finishes one, `Refs #123` if it only advances one, or label it: " +
          `\`${ESCAPE_HATCH_LABEL}\` if the change is genuinely trivial, ` +
          `\`${CLOSES_NOTHING_LABEL}\` if it is substantial and closes no ` +
          "issue by design (SCR-003).",
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
      reasons.push(missingDodReason(issue.ref, status.heading));
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
    const label = result.waivedBy ?? ESCAPE_HATCH_LABEL;
    const why =
      label === CLOSES_NOTHING_LABEL
        ? "this PR closes no issue by design"
        : "this change is trivial";
    return `SCR-003 DoD check waived by the \`${label}\` label — ${why}.`;
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
