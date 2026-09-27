/**
 * Cache writes never read (spec §12.8): a run that wrote prompt-cache tokens
 * and read none back. The counterfactual is the same prefix sent uncached, so
 * the saving is the write premium: the write cost minus the written tokens at
 * the run's input price. Cited at the run's operator, or at its agent when it
 * names no operator. It prices a part of each request, so it claims no frame
 * (ADR-206, counting rule 2).
 */
import { priceInputTokens, runInputPrice } from "../cost-rollup";
import {
  plural,
  type DetectContext,
  type Detector,
  type DetectInput,
  type FindingKey,
} from "./shared";

function detect(input: DetectInput, ctx: DetectContext): void {
  for (const run of input.runs) {
    const wrote = run.tokens.cache_write_5m + run.tokens.cache_write_1h;
    if (wrote === 0 || run.tokens.cache_read > 0) continue;
    const key: FindingKey | null =
      run.operatorKey !== null
        ? {
            kind: "cache_writes_never_read",
            level: "operator",
            subject: run.operatorKey,
          }
        : run.agentKey !== null
          ? {
              kind: "cache_writes_never_read",
              level: "agent",
              subject: run.agentKey,
            }
          : null;
    if (key === null || !ctx.groups.admits(key, run)) continue;
    let measured = 0n;
    for (const m of run.breakdown.models)
      measured += m.costByClass.cache_write_5m + m.costByClass.cache_write_1h;
    const price = runInputPrice(run);
    ctx.groups.add(
      key,
      input.window.start,
      run,
      {
        measuredTokens: wrote,
        counterfactualTokens: wrote,
        micros:
          price === null || measured === 0n
            ? null
            : { measured, counterfactual: priceInputTokens(price, wrote) },
      },
      // The finding is about the run's cache use as a whole, not a call.
      null,
    );
  }
}

export const cacheWritesNeverRead: Detector = {
  kinds: ["cache_writes_never_read"],
  counting: null,
  detect,
  prose: (group, evidence) => ({
    why: `${plural(group.runs.size, "run", "runs")} wrote ${plural(evidence.measuredTokens, "prompt-cache token", "prompt-cache tokens")} and read none of them back.`,
    fix: "Stop marking the prefix cacheable on runs that end before a second call reads it.",
  }),
};
