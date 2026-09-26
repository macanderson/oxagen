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
//
// A wrapped run is read as every chain it recorded, each subagent chain
// spliced in after the `subagent_start` that spawned it, with every recorded
// frame kept (`readRunChains`, #3823). The cap is over every chain together.
// A divergence on a subagent's frame names that chain in
// `divergentSessionUuid`, because a subagent chain numbers its frames from 0
// and the seq alone would name a frame on the run's own chain.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  runBisect,
  type RunBisectOutput,
} from "@oxagen/oxagen/contracts/run.bisect";
import { bisectFrames, readRunChains } from "@oxagen/run-ledger";
import {
  defaultRunReadDeps,
  resolveRun,
  runChainReads,
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
      readRunChains(runChainReads(deps, a), BISECT_FRAME_CAP),
      readRunChains(runChainReads(deps, b), BISECT_FRAME_CAP),
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
    // `divergentSeq` is run A's frame at the divergence, or run B's where A
    // has ended: the same position in each spliced list.
    const divergent =
      result.divergentSeq === null
        ? undefined
        : (framesA.frames[result.aligned] ?? framesB.frames[result.aligned]);
    const chain = divergent?.chain?.sessionUuid;
    return chain === undefined
      ? result
      : { ...result, divergentSessionUuid: chain };
  };
}

export const runBisectHandler = createRunBisectHandler(defaultRunReadDeps());
