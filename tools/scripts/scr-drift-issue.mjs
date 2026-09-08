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

/** The marker that identifies the drift issue. Must match the workflow's. */
export const MARKER = "<!-- scr-corpus-drift -->";

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
