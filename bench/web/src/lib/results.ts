import { parseEvalRun } from "./eval-schema";
import type { EvalRun } from "./types";

/**
 * Validate a batch of raw `oxagen.eval.v1` documents. Fails fast (throws) on
 * the first malformed document rather than silently dropping it — these are
 * files we committed ourselves, so a schema violation is a bug to fix, not
 * data to filter out. The actual result files live in `src/results-data/` and
 * are wired through this function by `src/results-data/index.ts`, which is
 * intentionally outside `src/lib/**` (and therefore outside the coverage
 * gate) since it is pure data wiring with no logic of its own.
 */
export function loadEvalRuns(rawDocs: readonly unknown[]): EvalRun[] {
  return rawDocs.map((doc) => parseEvalRun(doc));
}
