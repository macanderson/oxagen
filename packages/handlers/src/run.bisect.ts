// `bisect_runs`: the first frame at which two recordings diverge (Mission
// Control spec §8.4; ADR-058).
//
// Both runs are resolved in the caller's workspace and read in full through
// the run reader (lib/run-read.ts); the alignment itself is the pure
// `bisectFrames` (@oxagen/run-ledger), keyed on each frame's receipt and
// never on a body. A run longer than the read cap is compared over its
// first BISECT_FRAME_CAP frames; two such runs that agree throughout answer
// null over what was compared, and `aligned` says how much that was.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  runBisect,
  type RunBisectOutput,
} from "@oxagen/oxagen/contracts/run.bisect";
import { bisectFrames } from "@oxagen/run-ledger";
import { runScope } from "./run.list";
import {
  defaultRunReadDeps,
  readAllFrames,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";

export const BISECT_FRAME_CAP = 10_000;

export function createRunBisectHandler(
  deps: RunReadDeps,
): CapabilityHandler<typeof runBisect> {
  return async (input, ctx): Promise<RunBisectOutput> => {
    const scope = runScope(ctx);
    const [a, b] = await Promise.all([
      resolveRun(deps, scope, input.runA),
      resolveRun(deps, scope, input.runB),
    ]);
    const [framesA, framesB] = await Promise.all([
      readAllFrames(deps, a, BISECT_FRAME_CAP),
      readAllFrames(deps, b, BISECT_FRAME_CAP),
    ]);
    return bisectFrames(framesA.frames, framesB.frames);
  };
}

export const runBisectHandler = createRunBisectHandler(defaultRunReadDeps());
