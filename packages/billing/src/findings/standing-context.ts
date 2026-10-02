/**
 * Standing context (detector 2): the context every model call of a run
 * re-sends, priced as `standing_tokens × read_price × (requests − 1)` per run
 * and split by source (spec detector 2). The sources are the run-totals
 * columns F3 writes (#4493): tool definitions, context frames, and steering.
 * The rollup keeps each source's tokens on the calls after the run's first,
 * split by whether the call read the prompt cache (#4572), and
 * `standingContextBySource` prices that split. A row rolled up before then
 * holds only each source's sum, and the split is estimated from it.
 *
 * A re-sent token on a call that read the cache is priced at the run's cache
 * read price, and one on a call that read nothing at its input price, since
 * that call sent the prefix uncached. A run with no price for a side it
 * needs is cited and left out of the tokens, the split, and the saving.
 *
 * The fix moves a rarely called tool provider to Searchable and holds the
 * steering prefix to its budget. It does not change the context frames, so
 * their re-sent tokens are the counterfactual: the finding measures every
 * source, and its saving counts the tool definitions and steering alone. A
 * run whose only re-sent source is context frames has no saving the fix can
 * reach, so the finding leaves it out.
 *
 * Every recorder today estimates the sources, and the run-totals row keeps no
 * basis per source, so the finding's basis is `estimated`. It prices a part
 * of each request, so it claims no frame (ADR-208, counting rule 2). It is
 * cited at the run's agent, or at its operator when it names no agent.
 */
import type { RunTotalsRecord } from "../cost-rollup";
import {
  STANDING_SOURCES,
  standingContextBySource,
  standingSourcesOf as sourcesOf,
  type StandingSource,
} from "../standing-context-price";
import {
  agentOrOperator,
  plural,
  type DetectContext,
  type Detector,
  type DetectInput,
  type Group,
} from "./shared";

/** A run's re-sent standing context by source, priced; null when no source reported. */
function bySourceOf(run: RunTotalsRecord) {
  return standingContextBySource(run, sourcesOf(run));
}

function detect(input: DetectInput, ctx: DetectContext): void {
  for (const run of input.runs) {
    const bySource = bySourceOf(run);
    if (bySource === null) continue;
    const parts = STANDING_SOURCES.flatMap((source) => {
      const part = bySource[source];
      return part === null ? [] : [part];
    });
    const resent = parts.reduce((sum, part) => sum + part.resentTokens, 0);
    // The context frames the fix leaves in place; none when none were reported.
    const frames = bySource.contextFrameTokens;
    const kept = frames?.resentTokens ?? 0;
    if (resent - kept <= 0) continue;
    const key = agentOrOperator("standing_context", run);
    if (key === null || !ctx.groups.admits(key, run)) continue;
    let measured: bigint | null = 0n;
    for (const part of parts)
      measured =
        measured === null || part.micros === null
          ? null
          : measured + part.micros;
    ctx.groups.add(
      key,
      input.window.start,
      run,
      {
        measuredTokens: resent,
        counterfactualTokens: kept,
        micros:
          measured === null
            ? null
            : { measured, counterfactual: frames?.micros ?? 0n },
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
function resentOf(group: Group, source: StandingSource): number | null {
  let total: number | null = null;
  for (const { run } of pricedRuns(group)) {
    const part = bySourceOf(run)?.[source] ?? null;
    if (part !== null) total = (total ?? 0) + part.resentTokens;
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
  prose: (group, evidence) => {
    const frames = resentOf(group, "contextFrameTokens") ?? 0;
    return {
      why: `${plural(pricedRuns(group).length, "run", "runs")} re-sent ${plural(evidence.measuredTokens, "estimated token", "estimated tokens")} of standing context on every model call after the first: ${standingSplit(group)}.${frames > 0 ? " The saving leaves out the context frames, which the fix does not change." : ""}`,
      fix: "Move a tool provider whose tools agents rarely call to Searchable, and hold the steering prefix to its budget.",
    };
  },
};
