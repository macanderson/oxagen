import { loadEvalRuns } from "@/lib/results";
import type { EvalRun } from "@/lib/types";
import sample from "./sample.swe-bench-verified.eval.json";

/**
 * The committed result files, validated against `oxagen.eval.v1` and ready to
 * render. There are no measured Oxagen runs yet — a real SWE-bench Verified
 * run needs Docker plus model API keys and takes hours — so today this is
 * exactly one file, and it is explicitly SAMPLE data (see the JSON's
 * `labels.provenance`). When `pnpm bench:swe:compare` produces a real run,
 * drop the emitted `*.eval.json` file next to this one and add it to the
 * array below; `loadEvalRuns` will fail the build if it doesn't match the
 * schema.
 */
export const EVAL_RUNS: readonly EvalRun[] = loadEvalRuns([sample]);
