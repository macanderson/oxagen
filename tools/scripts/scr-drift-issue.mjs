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
 */

/** The marker that identifies the drift issue. Must match the workflow's. */
export const MARKER = "<!-- scr-corpus-drift -->";

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
    if (typeof body === "string" && body.includes(marker)) {
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
 * @returns `{ action: "update", number }`, `{ action: "create" }`, or
 *          `{ action: "abort", reason }`
 */
export function decideDriftAction(confirmed) {
  if (confirmed.length > 1) {
    return {
      action: "abort",
      reason:
        `Several issues carry the drift marker (${confirmed.join(", ")}). ` +
        "Close all but one, then re-run.",
    };
  }
  if (confirmed.length === 1) {
    return { action: "update", number: confirmed[0] };
  }
  return { action: "create" };
}
