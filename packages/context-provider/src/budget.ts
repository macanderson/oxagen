/**
 * Fitting frames into the budget a host asked for.
 *
 * A `ContextQuery` carries two ceilings — `max_frames` and `max_tokens` — and
 * a provider that returns more than either has spent context the host had
 * already allocated elsewhere. Both are hard.
 *
 * ## Skip, do not stop
 *
 * Frames are considered best-first, and one that does not fit is skipped while
 * the walk continues. Stopping at the first overflow would let a single large
 * frame near the top of the ranking discard every smaller frame beneath it,
 * so a budget of 500 tokens could come back empty while ten 40-token frames
 * were available and relevant. Skipping fills the budget; stopping wastes it.
 *
 * The cost is that the result is not a prefix of the ranking. That is the
 * right trade for a fixed budget, and it is why `dropped_estimate` is reported
 * rather than left for the host to infer from a count.
 */
import type {
  ContextFrame,
  ContextQueryResult,
} from "@contextgraphprotocol/typescript-sdk";

export interface BudgetLimits {
  maxFrames: number;
  maxTokens: number;
}

/**
 * Select the frames that fit, best-first.
 *
 * `truncated` says whether anything was left out for any reason, and
 * `dropped_estimate` counts it. The count is exact here — the name is the
 * protocol's, which allows a provider that can only estimate.
 */
export function packWithinBudget(
  frames: readonly ContextFrame[],
  limits: BudgetLimits,
): ContextQueryResult {
  const maxFrames = Math.max(0, Math.floor(limits.maxFrames));
  const maxTokens = Math.max(0, Math.floor(limits.maxTokens));

  const ranked = [...frames].sort(byScoreThenId);
  const kept: ContextFrame[] = [];
  let spent = 0;

  for (const frame of ranked) {
    if (kept.length >= maxFrames) break;
    const cost = frame.token_cost;
    if (spent + cost > maxTokens) continue;
    kept.push(frame);
    spent += cost;
  }

  const dropped = ranked.length - kept.length;
  const result: ContextQueryResult = { frames: kept, truncated: dropped > 0 };
  if (dropped > 0) result.dropped_estimate = dropped;
  return result;
}

/**
 * Best-first, and deterministic when two frames tie.
 *
 * Sorting on score alone leaves equal-scored frames in whatever order the
 * store returned them, which makes the same query answer differently between
 * runs and turns a budget boundary into a coin toss. The id is a content hash,
 * so it is a stable tiebreak that does not encode arrival order.
 */
function byScoreThenId(a: ContextFrame, b: ContextFrame): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
