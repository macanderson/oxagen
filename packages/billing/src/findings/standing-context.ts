/**
 * Standing context (detector 2): the context every turn of a run re-sends,
 * priced as `standing_tokens × read_price × (requests − 1)` per run and split
 * by source (spec detector 2). The sources are the run-totals columns F3
 * writes (#4493): tool definitions, context frames, and steering. Each column
 * holds a sum over the run's model calls, so one call's share is the sum over
 * the calls, and every call after the first re-sent it.
 *
 * The price is the run's prompt-cache read price, since a re-sent prefix is a
 * cache read. A run that read nothing from the cache sent its prefix
 * uncached, so it falls back to the run's input price. A run with neither
 * price is cited and left out of the tokens, the split, and the saving.
 *
 * Every recorder today estimates the sources, and the run-totals row keeps no
 * basis per source, so the finding's basis is `estimated`. It prices a part
 * of each request, so it claims no frame (ADR-208, counting rule 2). It is
 * cited at the run's agent, or at its operator when it names no agent.
 */
import { priceInputTokens } from "../cost-rollup";
import {
  resentStandingTokens,
  resentTokens,
  standingReadPrice,
  standingSourcesOf as sourcesOf,
  type StandingContextSources,
} from "../standing-context-price";
import {
  agentOrOperator,
  plural,
  type DetectContext,
  type Detector,
  type DetectInput,
  type Group,
} from "./shared";

function detect(input: DetectInput, ctx: DetectContext): void {
  for (const run of input.runs) {
    const resent = resentStandingTokens(sourcesOf(run), run.modelCalls);
    if (resent === null || resent === 0) continue;
    const key = agentOrOperator("standing_context", run);
    if (key === null || !ctx.groups.admits(key, run)) continue;
    const price = standingReadPrice(run);
    ctx.groups.add(
      key,
      input.window.start,
      run,
      {
        measuredTokens: resent,
        counterfactualTokens: 0,
        micros:
          price === null
            ? null
            : { measured: priceInputTokens(price, resent), counterfactual: 0n },
        basis: "estimated",
      },
      // The finding is about each run's prefix as a whole, not a call.
      null,
    );
  }
}

/**
 * The runs whose re-sent context the finding priced. A run with no read
 * price is cited and left out of the finding's tokens and saving, so the
 * split and the run count leave it out too, and the parts add up to the
 * total the finding states.
 */
function pricedRuns(group: Group) {
  return [...group.runs.values()].filter((acc) => acc.covered > 0);
}

/** The re-sent tokens of one source over a group's priced runs; null when none reported it. */
function resentOf(
  group: Group,
  source: keyof StandingContextSources,
): number | null {
  let total: number | null = null;
  for (const { run } of pricedRuns(group)) {
    const tokens = sourcesOf(run)[source];
    if (tokens !== null)
      total = (total ?? 0) + resentTokens(tokens, run.modelCalls);
  }
  return total;
}

/** The split by source, in the order the run page lists it, leaving out a source no run reported. */
export function standingSplit(group: Group): string {
  const parts = [
    ["toolDefinitionTokens", "tool definitions"],
    ["steeringTokens", "steering"],
    ["contextFrameTokens", "context frames"],
  ] as const;
  const named = parts.flatMap(([source, label]) => {
    const tokens = resentOf(group, source);
    return tokens === null
      ? []
      : [`${tokens.toLocaleString("en-US")} of ${label}`];
  });
  if (named.length <= 2) return named.join(" and ");
  return `${named.slice(0, -1).join(", ")}, and ${named.at(-1)}`;
}

export const standingContext: Detector = {
  kinds: ["standing_context"],
  counting: null,
  detect,
  prose: (group, evidence) => ({
    why: `${plural(pricedRuns(group).length, "run", "runs")} re-sent ${plural(evidence.measuredTokens, "estimated token", "estimated tokens")} of standing context on every turn after the first: ${standingSplit(group)}.`,
    fix: "Move a tool provider whose tools agents rarely call to Searchable, and hold the steering prefix to its budget.",
  }),
};
