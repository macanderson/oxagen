/**
 * PR CI monitoring — watch a pull request's checks, report, and (when green)
 * merge. The pure classification lives here so it's testable without GitHub;
 * `commands/pr.ts` does the polling + `gh` calls on top.
 *
 * The goal is that the developer never wonders where a PR stands: `oxagen pr
 * status` gives a one-shot verdict, `oxagen pr watch` streams status as checks
 * resolve and stops at a terminal state (all green, or something failed), and
 * offers to merge once green.
 */

/** One entry from `gh pr view --json statusCheckRollup`. */
export interface CheckRollupItem {
  /** Check-run name (checks) — present for GitHub Actions / most checks. */
  name?: string | null;
  /** Status-context name (legacy commit statuses). */
  context?: string | null;
  /** Check-run conclusion: SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STARTUP_FAILURE. */
  conclusion?: string | null;
  /** Status state (legacy) or check status: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED. */
  state?: string | null;
  /** Link to the check's details. */
  detailsUrl?: string | null;
  targetUrl?: string | null;
}

export type ChecksState = "green" | "failing" | "pending" | "none";

export interface ChecksSummary {
  state: ChecksState;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** The checks that are failing — what an agent must fix to get to green. */
  failing: Array<{ name: string; url?: string }>;
}

const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
// CANCELLED is almost always a SUPERSEDED run on a fast-moving branch, not a
// real failure — treat it as ignorable rather than red so a stale cancelled run
// doesn't wedge "watch until green".
const IGNORE = new Set(["CANCELLED", "STALE", "EXPECTED"]);
const FAIL = new Set([
  "FAILURE",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

function itemName(item: CheckRollupItem): string {
  return item.name || item.context || "check";
}

function itemUrl(item: CheckRollupItem): string | undefined {
  return item.detailsUrl || item.targetUrl || undefined;
}

/** Classify one rollup item as pass / fail / pending / ignore. */
function classify(
  item: CheckRollupItem,
): "pass" | "fail" | "pending" | "ignore" {
  const c = (item.conclusion || "").toUpperCase();
  const s = (item.state || "").toUpperCase();
  if (FAIL.has(c) || FAIL.has(s)) return "fail";
  if (PASS.has(c) || PASS.has(s)) return "pass";
  if (IGNORE.has(c) || IGNORE.has(s)) return "ignore";
  // No conclusion yet and not a terminal state ⇒ still running.
  return "pending";
}

/**
 * Summarize a PR's check rollup into a single verdict. `failing` lists exactly
 * the checks blocking green, so a fix-to-green loop knows what to fix. A PR with
 * no checks at all is `none` (nothing to wait on). Pure. Exported for tests.
 */
export function summarizeChecks(items: CheckRollupItem[]): ChecksSummary {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const failing: Array<{ name: string; url?: string }> = [];
  for (const item of items) {
    switch (classify(item)) {
      case "pass":
        passed++;
        break;
      case "fail":
        failed++;
        failing.push({ name: itemName(item), url: itemUrl(item) });
        break;
      case "pending":
        pending++;
        break;
      case "ignore":
        break;
    }
  }
  const total = passed + failed + pending;
  let state: ChecksState;
  if (failed > 0) state = "failing";
  else if (pending > 0) state = "pending";
  else if (total > 0) state = "green";
  else state = "none";
  return { state, total, passed, failed, pending, failing };
}

/** A terminal state for `watch` — stop polling once green, failing, or none. */
export function isTerminal(summary: ChecksSummary): boolean {
  return summary.state !== "pending";
}

/** One-line human summary of a checks verdict. */
export function formatSummary(summary: ChecksSummary): string {
  switch (summary.state) {
    case "green":
      return `✓ all ${summary.passed} checks passed`;
    case "failing":
      return `✗ ${summary.failed} failing (${summary.passed} passed, ${summary.pending} pending): ${summary.failing
        .map((f) => f.name)
        .join(", ")}`;
    case "pending":
      return `⧗ ${summary.pending} pending, ${summary.passed} passed${summary.failed ? `, ${summary.failed} failed` : ""}`;
    case "none":
      return "no checks reported for this PR";
  }
}
