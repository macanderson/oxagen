/**
 * Finding the SCR-corpus drift issue.
 *
 * Extracted from `.github/workflows/scr-corpus-check.yml` so the lookup can be
 * tested. It could not be, inline, and it destroyed an unrelated issue's body
 * before anyone noticed (#2666).
 *
 * The bug was trusting GitHub's search. `search.issuesAndPullRequests` is a
 * PHRASE search: a quoted HTML comment is tokenised, so the query matches any
 * issue containing those words in that order. It matched an issue about
 * workflow pinning, and the job replaced that issue's whole body with a drift
 * report.
 *
 * So search is a candidate list here, never an answer. Every hit is re-read
 * and kept only if its body genuinely contains the marker — an exact substring
 * test the search API cannot offer.
 *
 * A substring test is not the whole answer either. An issue that *documents*
 * the marker quotes it exactly, and quoting is what writing about this check
 * looks like: #2699 asks for the close-on-green behaviour and spells the
 * marker in a code span to say which one to match. That body carries the
 * marker as a citation, not as a claim to be the drift issue, and counting it
 * aborted the job and left `main` red (run 34172143469). So the marker is
 * looked for in the prose only — code spans and fenced blocks are stripped
 * first, the same exemption stella's prose guard makes for naming a banned
 * construction in order to ban it.
 */

import { dodStatus } from "./scr-dod-check.mjs";

/** The marker that identifies the drift issue. Must match the workflow's. */
export const MARKER = "<!-- scr-corpus-drift -->";

/**
 * The drift issue's definition of done. A green run of `scr-corpus-check`
 * proves both items, so the job can tick them and close the issue itself.
 *
 * The DoD used to add "Residue filed as new issues", which no run can verify.
 * The close step closed the issue as completed with all three boxes empty,
 * which SCR-003 forbids, and escaped `dod-close-guard` only because events
 * raised with GITHUB_TOKEN start no other workflow. Keep every item here
 * machine-verifiable; the close step still leaves open any issue whose DoD
 * holds an item it did not tick.
 */
export const DRIFT_DOD_ITEMS = [
  "Every `docs/scr/` file named above is removed",
  "`scr-corpus-check` is green",
];

/** The DoD section the filing step writes, every box unticked. */
export function driftDodSection() {
  return [
    "### Definition of done",
    "",
    ...DRIFT_DOD_ITEMS.map((item) => `- [ ] ${item}`),
  ].join("\n");
}

/**
 * Prepare the drift issue for a close after a green run.
 *
 * Ticks each {@link DRIFT_DOD_ITEMS} box, since the green run verified it, and
 * leaves every other box as it was. `close` is true only when the DoD is
 * present and nothing in it is left unticked, which is the bar SCR-003 and
 * `dod-close-guard` hold a person to. An older issue that still lists the
 * residue item stays open, and `unchecked` names what a person has to do.
 *
 * @param body the issue body
 * @returns `{ body, changed, close, unchecked }`
 */
export function prepareDriftClose(body) {
  const original = body ?? "";
  const ticked = original
    .split("\n")
    .map((line) => {
      // `(\r?)` keeps a CRLF line, which a body edited on github.com carries.
      const item = line.match(/^(\s*[-*]\s*)\[ \](\s*)(.*?)(\r?)$/);
      if (!item || !DRIFT_DOD_ITEMS.includes(item[3].trim())) return line;
      return `${item[1]}[x]${item[2]}${item[3]}${item[4]}`;
    })
    .join("\n");
  const status = dodStatus(ticked);
  return {
    body: ticked,
    changed: ticked !== original,
    close: status.present && status.unchecked.length === 0,
    unchecked: status.unchecked,
  };
}

/**
 * Remove fenced blocks and inline code spans, leaving the prose.
 *
 * Fences go first: one can contain backtick runs that would otherwise read as
 * span delimiters. A span's closing run must match its opening run, so the
 * backreference is what keeps ``` `a` and `b` `` from collapsing into one.
 */
function stripCode(text) {
  return text
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, " ")
    .replace(/(`+)[\s\S]*?\1/g, " ");
}

/**
 * Narrow search hits to the issues that actually carry the marker.
 *
 * @param candidates search results — only `number` is read
 * @param fetchBody  given an issue number, returns its body (or null)
 * @param marker     defaults to {@link MARKER}
 * @returns the confirmed issue numbers, in the order given
 */
export async function confirmMarkedIssues(
  candidates,
  fetchBody,
  marker = MARKER,
) {
  const confirmed = [];
  for (const item of candidates ?? []) {
    const body = await fetchBody(item.number);
    if (typeof body === "string" && stripCode(body).includes(marker)) {
      confirmed.push(item.number);
    }
  }
  return confirmed;
}

/**
 * What the job should do about the confirmed set.
 *
 * Two marked issues is not something this job can resolve: picking one would
 * silently orphan the other, which is the same mistake as acting on an
 * unverified search hit. It stops and says so.
 *
 * The message names both remedies, because naming only the destructive one
 * invites it. "Close all but one" was the whole instruction, and one of the
 * two issues is often a live issue that merely quotes the marker — closing
 * that destroys real work to turn a check green. #2706 repaired the same
 * shape in the DoD gate, whose message said "refile it with the task
 * template" and meant: delete this issue.
 *
 * @returns `{ action: "update", number }`, `{ action: "create" }`, or
 *          `{ action: "abort", reason }`
 */
export function decideDriftAction(confirmed) {
  if (confirmed.length > 1) {
    return {
      action: "abort",
      reason:
        `Several issues carry the drift marker (${confirmed.join(", ")}). ` +
        "Exactly one issue may carry it. Check each: the one that reports a " +
        "drift keeps the marker; one that only writes about this check should " +
        "have its marker wrapped in backticks, not be closed. Close an issue " +
        "only if it is a genuine duplicate report. Then re-run.",
    };
  }
  if (confirmed.length === 1) {
    return { action: "update", number: confirmed[0] };
  }
  return { action: "create" };
}

/**
 * What the job should do about the confirmed set once the check is green.
 *
 * The drift issue's definition of done says `scr-corpus-check` is green. Until
 * this ran, nothing closed the issue when that became true, so a clean corpus
 * still showed an open drift report (#2978). The close follows the same rules
 * as the update: only an issue confirmed by {@link confirmMarkedIssues} is a
 * candidate, so an issue that quotes the marker in backticks is never closed.
 * Two confirmed issues stop the job for the reason {@link decideDriftAction}
 * gives, because closing both could close a live issue by mistake.
 *
 * @returns `{ action: "close", number }`, `{ action: "noop" }`, or
 *          `{ action: "abort", reason }`
 */
export function decideCloseAction(confirmed) {
  if (confirmed.length > 1) {
    return { action: "abort", reason: decideDriftAction(confirmed).reason };
  }
  if (confirmed.length === 1) {
    return { action: "close", number: confirmed[0] };
  }
  return { action: "noop" };
}
