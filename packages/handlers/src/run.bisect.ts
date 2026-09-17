// `bisect_runs`: the first frame at which two recordings diverge (Mission
// Control spec §8.4; ADR-058).
//
// Both runs are resolved in the caller's workspace and read in full through
// the run reader (lib/run-read.ts); the alignment itself is the pure
// `bisectFrames` (@oxagen/run-ledger), keyed on each frame's receipt and
// never on a body. A run longer than the read cap is compared over its
// first BISECT_FRAME_CAP frames. A divergence inside that prefix is answered;
// when the prefixes agree and either run was cut, the handler refuses with
// `conflict` (`run_exceeds_bisect_cap`), because the frames past the cap were
// never compared and `null` would claim the runs are identical.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  runBisect,
  type RunBisectOutput,
} from "@oxagen/oxagen/contracts/run.bisect";
import { bisectFrames } from "@oxagen/run-ledger";
import {
  defaultRunReadDeps,
  readAllFrames,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";

const BISECT_FRAME_CAP = 10_000;

export function createRunBisectHandler(
  deps: RunReadDeps,
): CapabilityHandler<typeof runBisect> {
  return async (input, ctx): Promise<RunBisectOutput> => {
    const [a, b] = await Promise.all([
      resolveRun(deps, ctx, input.runA),
      resolveRun(deps, ctx, input.runB),
    ]);
    const [framesA, framesB] = await Promise.all([
      readAllFrames(deps, a, BISECT_FRAME_CAP),
      readAllFrames(deps, b, BISECT_FRAME_CAP),
    ]);
    const result = bisectFrames(framesA.frames, framesB.frames);
    if (
      result.divergentSeq === null &&
      !(framesA.complete && framesB.complete)
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "run_exceeds_bisect_cap",
      });
    }
    return result;
  };
}

export const runBisectHandler = createRunBisectHandler(defaultRunReadDeps());
