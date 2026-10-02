/**
 * Spend with no outcome (detector 8, ADR-208): runs whose work did not land.
 * A run counts when every pull request it opened closed unmerged, or merged
 * and was reverted within `REVERT_WINDOW_DAYS` of the merge. A run that
 * opened none counts only when its terminal reason says it was abandoned.
 * The outcomes come from `cost.run_pr_outcomes` (#4491, ../run-pr-outcomes.ts).
 *
 * The finding prices each of the run's model-call frames whole, against
 * nothing, and claims it as detector 8. It runs after detectors 1 and 7, so a
 * frame either of them claimed this pass is skipped and counts once. Each
 * model call the rollup counted and the read did not return is cited and not
 * priced: every call of a run the frame cap left unread, and each call a short
 * read missed. Coverage counts every call of the run, so the coverage gate
 * sees the calls a short read missed. A run whose rollup counted no model
 * call, and whose read returned no frame, spent nothing, so it is left out.
 *
 * A run stays unpriced until its outcome is read: a pull request whose state
 * is not read yet, or one still open, leaves the whole run out. A merged pull
 * request that no revert undid within the window is an outcome. So is one
 * whose merge or revert time is unknown, and one whose revert is dated before
 * its merge.
 */
import type { RunTotalsRecord } from "../cost-rollup";
import { NO_PR_KEY, type OutcomeRow } from "../run-pr-outcomes";
import { claimKey } from "./requests";
import {
  agentOrOperator,
  plural,
  requestMeasure,
  type Detector,
  type FindingValues,
  type Group,
} from "./shared";

/** A revert this many days or fewer after the merge undoes the run's work. */
export const REVERT_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The terminal reasons that say a run was given up before it finished. Each
 * harness writes its own free text here, so the list holds only the value
 * that names it: `abandoned`, a ledger seal's terminal status.
 */
export const ABANDONED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "abandoned",
]);

/** Why a run's work did not land. */
export type NoOutcomeReason = "closed_unmerged" | "reverted" | "abandoned";

type PrOutcome = NoOutcomeReason | "landed" | "unread";

function revertedInWindow(row: OutcomeRow): boolean {
  if (!row.reverted || row.mergedAt === null || row.revertedAt === null)
    return false;
  const delta = row.revertedAt.getTime() - row.mergedAt.getTime();
  // No check on `cost.run_pr_outcomes` puts a revert after its merge. A
  // revert dated before its merge has no timing to trust, so the merge stands.
  return delta >= 0 && delta <= REVERT_WINDOW_DAYS * DAY_MS;
}

function prOutcome(row: OutcomeRow): PrOutcome {
  if (row.merged || row.prState === "merged")
    return revertedInWindow(row) ? "reverted" : "landed";
  if (row.prState === "closed") return "closed_unmerged";
  // Not read yet, or still open: the pull request may still merge.
  return "unread";
}

/**
 * Why a run's work did not land, from its outcome rows; null when some of it
 * landed, or when an outcome is not read yet. A reverted pull request wins
 * over a closed one when a run has both.
 */
export function noOutcomeReason(
  rows: readonly OutcomeRow[],
): NoOutcomeReason | null {
  const prs = rows.filter((r) => r.prKey !== NO_PR_KEY);
  if (prs.length === 0) {
    const none = rows.find((r) => r.prKey === NO_PR_KEY);
    return none !== undefined &&
      none.terminalReasonReadAt !== null &&
      none.terminalReason !== null &&
      ABANDONED_TERMINAL_REASONS.has(none.terminalReason)
      ? "abandoned"
      : null;
  }
  let reason: NoOutcomeReason = "closed_unmerged";
  for (const row of prs) {
    const outcome = prOutcome(row);
    if (outcome === "landed" || outcome === "unread") return null;
    if (outcome === "reverted") reason = "reverted";
  }
  return reason;
}

/** Why each cited run's work did not land, keyed by the run record the groups hold. */
const reasonOf = new WeakMap<RunTotalsRecord, NoOutcomeReason>();

/** The cited runs by why their work did not land, the figures the card names (#5023). */
function valuesOf(group: Group): FindingValues {
  const counts: Record<NoOutcomeReason, number> = {
    closed_unmerged: 0,
    reverted: 0,
    abandoned: 0,
  };
  for (const { run } of group.runs.values()) {
    const reason = reasonOf.get(run);
    if (reason !== undefined) counts[reason] += 1;
  }
  return {
    kind: "spend_with_no_outcome",
    closedUnmerged: counts.closed_unmerged,
    reverted: counts.reverted,
    abandoned: counts.abandoned,
  };
}

export const spendWithNoOutcome: Detector = {
  kinds: ["spend_with_no_outcome"],
  counting: 8,
  detect(input, ctx) {
    // Detector 8 prices only the runs whose outcome rows the pass read, and
    // nothing when it read none.
    const outcomes = input.outcomes;
    if (outcomes === undefined) return;
    for (const run of input.runs) {
      const rows = outcomes.get(run.runId);
      const reason = rows === undefined ? null : noOutcomeReason(rows);
      if (reason === null) continue;
      const key = agentOrOperator("spend_with_no_outcome", run);
      if (key === null || !ctx.groups.admits(key, run)) continue;
      // A run absent here was not read: the frame cap left it out, or it has
      // no frame source.
      const frames = input.frames?.get(run.runId) ?? [];
      // The rollup counted no model call, and the read found none, so the run
      // spent nothing. Citing it would add an unpriced call and pull the
      // group's coverage down.
      if (frames.length === 0 && run.modelCalls === 0) continue;
      reasonOf.set(run, reason);
      for (const frame of frames) {
        const claim = claimKey(run.runId, frame.key);
        if (ctx.claimed.has(claim)) continue;
        ctx.claimed.add(claim);
        ctx.groups.add(
          key,
          input.window.start,
          run,
          requestMeasure(frame),
          null,
          { detector: 8, frame },
        );
      }
      // Each call the rollup counted and the read did not return is cited,
      // and nothing prices it. A frame an earlier detector claimed was read,
      // so it is not missing. A read with more frames than the rollup counted
      // adds none.
      for (let i = frames.length; i < run.modelCalls; i += 1)
        ctx.groups.add(
          key,
          input.window.start,
          run,
          requestMeasure(null),
          null,
        );
    }
  },
  prose: (group) => ({
    why: `${plural(group.runs.size, "run", "runs")} ended with nothing kept. Each pull request closed unmerged or was reverted within ${REVERT_WINDOW_DAYS} days of its merge, or the run was abandoned before it opened one.`,
    fix: "Read why each pull request closed or was reverted, and send work whose runs keep ending this way back to its work item with the spend attached.",
    values: valuesOf(group),
  }),
};
