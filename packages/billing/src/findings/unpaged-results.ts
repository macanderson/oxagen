/**
 * Unpaged results (detector 5): a tool call whose result is above
 * `UNPAGED_RESULT_TOKENS`, re-priced at one page of `PAGE_TOKENS` at the
 * run's input price. It prices a part of a request, so it claims no frame
 * (ADR-208, counting rule 2). A call a repeat finding can cite is left to
 * that finding, whether or not its request counted.
 */
import type { RunTotalsRecord } from "../cost-rollup";
import type { ViewCall } from "./requests";
import {
  PAGE_TOKENS,
  plural,
  resultMeasure,
  UNPAGED_RESULT_TOKENS,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
} from "./shared";

/** Whether a repeat finding can cite the call: a shell repeat, or a read-only repeat on a run that names an agent or operator. */
function citableRepeat(c: ViewCall, run: RunTotalsRecord): boolean {
  return (
    c.repeat === "shell" ||
    (c.repeat === "read" && (run.agentKey !== null || run.operatorKey !== null))
  );
}

function detect(input: DetectInput, ctx: DetectContext): void {
  for (const view of ctx.views) {
    for (const c of view.calls) {
      if (ctx.taken.has(c.call) || citableRepeat(c, view.run)) continue;
      const tokens = c.call.resultTokens;
      if (tokens === null || tokens <= UNPAGED_RESULT_TOKENS) continue;
      const key: FindingKey = {
        kind: "unpaged_results",
        level: "tool",
        subject: c.call.tool,
      };
      if (!ctx.groups.admits(key, view.run)) continue;
      ctx.groups.add(
        key,
        input.toolWindowStart,
        view.run,
        resultMeasure(view.run, tokens, () => PAGE_TOKENS),
        [c.frame],
      );
    }
  }
}

export const unpagedResults: Detector = {
  kinds: ["unpaged_results"],
  counting: null,
  detect,
  prose: (group, evidence) => ({
    why: `${plural(evidence.calls, "call", "calls")} to ${group.subject} on ${plural(group.runs.size, "run", "runs")} returned more than ${UNPAGED_RESULT_TOKENS.toLocaleString("en-US")} result tokens into the context.`,
    fix: `Page ${group.subject}'s results at ${PAGE_TOKENS.toLocaleString("en-US")} tokens and fetch the rest on demand.`,
  }),
};
