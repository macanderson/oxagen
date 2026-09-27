/**
 * Spend with no outcome (detector 8, ADR-208): runs whose work did not land.
 * A run counts when every pull request it opened closed unmerged, or merged
 * and was reverted within `REVERT_WINDOW_DAYS` of the merge. A run that
 * opened none counts only when its terminal reason says it was abandoned.
 * The outcomes come from `cost.run_pr_outcomes` (#4491, ../run-pr-outcomes.ts).
 *
 * The finding prices each of the run's model-call frames whole, against
 * nothing, and claims it as detector 8. It runs after detectors 1 and 7, so a
 * frame either of them claimed this pass is skipped and counts once. A run
 * whose frames were not read is cited and not priced.
 *
 * A run stays unpriced until its outcome is read: a pull request whose state
 * is not read yet, or one still open, leaves the whole run out. A merged pull
 * request that no revert undid within the window is an outcome, and so is one
 * whose merge or revert time is unknown.
 */
import { NO_PR_KEY, type OutcomeRow } from "../run-pr-outcomes";
import { claimKey } from "./requests";
import {
  agentOrOperator,
  plural,
  requestMeasure,
  type Detector,
} from "./shared";

declare module "./shared" {
  interface DetectInput {
    /**
     * Each run's rows of `cost.run_pr_outcomes`, by run public id. Detector 8
     * prices only the runs listed here, and it prices nothing when this is
     * absent.
     */
    outcomes?: ReadonlyMap<string, readonly OutcomeRow[]>;
  }
}

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
  return (
    row.revertedAt.getTime() - row.mergedAt.getTime() <=
    REVERT_WINDOW_DAYS * DAY_MS
  );
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

export const spendWithNoOutcome: Detector = {
  kinds: ["spend_with_no_outcome"],
  counting: 8,
  detect(input, ctx) {
    const outcomes = input.outcomes;
    if (outcomes === undefined) return;
    for (const run of input.runs) {
      const rows = outcomes.get(run.runId);
      if (rows === undefined || noOutcomeReason(rows) === null) continue;
      const key = agentOrOperator("spend_with_no_outcome", run);
      if (key === null || !ctx.groups.admits(key, run)) continue;
      const frames = input.frames?.get(run.runId);
      if (frames === undefined || frames.length === 0) {
        // No frames were read for the run: it is cited, and nothing prices it.
        ctx.groups.add(
          key,
          input.window.start,
          run,
          requestMeasure(null),
          null,
        );
        continue;
      }
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
    }
  },
  prose: (group) => ({
    why: `${plural(group.runs.size, "run", "runs")} ended with nothing kept. Each pull request closed unmerged or was reverted within ${REVERT_WINDOW_DAYS} days of its merge, or the run was abandoned before it opened one.`,
    fix: "Read why each pull request closed or was reverted, and send work whose runs keep ending this way back to its work item with the spend attached.",
  }),
};
