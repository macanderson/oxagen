// `get_run_context`: each model request's window, block by block, and the
// steering assembler's manifests (ADR-200; #3894).
//
// The window is read from the frames that record the model calls, never from
// Neo4j, whose USED_CONTEXT edges are a best-effort projection no read
// depends on:
//
//   tse_…  a wrapped session: its `llm_call` rows, with the proxy's
//          `oxagen.window` attribute and the usage the vendor reported, and
//          its `steering.manifest` rows. A call only a transcript or OTel
//          reported, or one the proxy saw on an API it does not parse,
//          carries no window and is counted as unmeasured. A later sighting
//          of a call the proxy measured is not counted twice.
//   arun_… a ledger run: its `model.engine_call_started` frames, whose
//          payload carries the window, joined to the completions that
//          carry the provider's token counts on `model_call_id`.
//
// Both are scoped through `resolveRun`, which is where a run outside the
// caller's workspace becomes `not_found`. Each block's tokens are its byte
// share of the prompt total the vendor reported, so the blocks sum to it.
// The composition sums each block over every window the run recorded, which
// is how the Cost tab reads a run's prompt split (#5295). A ledger run's is
// summed over the windows its walk reached. A wrapped run's is summed over
// every chain of the run, its subagents' included, with the read and the sum
// the cost rollup stores on the run's row (#5341), so the Cost tab and the
// Agent page agree. The `windows` list stays the root chain's, which is the
// chain the Context tab draws.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  RUN_CONTEXT_ASSEMBLY_MAX,
  RUN_CONTEXT_WINDOW_MAX,
  runContextGet,
  type RunContextGetOutput,
} from "@oxagen/oxagen/contracts/run.context.get";
import {
  type ContextWindowReading,
  streamedWindowComposition,
  type TachoModelCallRow,
  walkLedgerContextWindows,
  type WindowComposition,
  windowComposition,
  wrappedContextWindows,
} from "@oxagen/run-ledger";
import { readTachoWindowFrames } from "@oxagen/telemetry";
import { readTachoModelCalls } from "./lib/run-context";
import {
  defaultRunReadDeps,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";

/** The most ledger events one read walks before it says the lists are a prefix. */
const LEDGER_EVENT_CAP = 20_000;
/** Events per page of that walk. */
const LEDGER_PAGE = 500;
/** The most `llm_call` and manifest rows one read of a wrapped session takes. */
const TACHO_ROW_CAP = 5_000;

export type RunContextGetDeps = RunReadDeps & {
  modelCalls: (
    sessionUuid: string,
    limit: number,
  ) => Promise<TachoModelCallRow[]>;
  /** The windowed `llm_call` rows on the listed chains of a wrapped run. */
  windowFrames: typeof readTachoWindowFrames;
};

/**
 * A wrapped run's composition over every chain of the run: the root and each
 * subagent session `tachoChildSessions` lists, the chains the cost rollup
 * reads. A reader built without the session list sums the root alone.
 */
async function wrappedComposition(
  deps: RunContextGetDeps,
  scope: { orgId: string; workspaceId: string },
  rootSessionUuid: string,
): Promise<WindowComposition | null> {
  const children =
    deps.tachoChildSessions === undefined
      ? []
      : await deps.tachoChildSessions(rootSessionUuid);
  const run = {
    ...scope,
    rootSessionUuid,
    sessionUuids: [rootSessionUuid, ...children],
  };
  return streamedWindowComposition((consume) =>
    deps.windowFrames(run, consume),
  );
}

/**
 * A ledger run's windows, from its model-call and manifest events. The walk
 * is the one the cost rollup reads a run's composition through (#5341).
 */
function ledgerReading(
  deps: RunContextGetDeps,
  runId: string,
): Promise<ContextWindowReading> {
  return walkLedgerContextWindows(
    (after, limit) => deps.store.readAttemptEventsSince(runId, after, limit),
    { cap: LEDGER_EVENT_CAP, page: LEDGER_PAGE },
  );
}

/** A wrapped session's windows, from its `llm_call` and manifest rows. */
async function wrappedReading(
  deps: RunContextGetDeps,
  sessionUuid: string,
): Promise<ContextWindowReading> {
  // One over the cap, so a full read is told apart from a cut one.
  const rows = await deps.modelCalls(sessionUuid, TACHO_ROW_CAP + 1);
  return {
    ...wrappedContextWindows(rows.slice(0, TACHO_ROW_CAP)),
    walked: rows.length <= TACHO_ROW_CAP,
  };
}

export function createRunContextGetHandler(
  deps: RunContextGetDeps,
): CapabilityHandler<typeof runContextGet> {
  return async (input, ctx): Promise<RunContextGetOutput> => {
    const run = await resolveRun(deps, ctx, input.runId);
    const reading =
      run.source === "tacho"
        ? await wrappedReading(deps, run.sessionUuid)
        : await ledgerReading(deps, run.runId);
    // A ledger run's composition is summed over every window the walk
    // reached, before the list is cut to the contract's length, so a long
    // run's composition is not a prefix's. A wrapped run's is summed over
    // every chain of the run.
    const composition =
      run.source === "tacho"
        ? await wrappedComposition(
            deps,
            { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
            run.sessionUuid,
          )
        : windowComposition(reading.windows);
    return {
      runId: input.runId,
      source: run.source === "tacho" ? "wrapped" : "ledger",
      windows: reading.windows.slice(0, RUN_CONTEXT_WINDOW_MAX),
      unmeasured: reading.unmeasured,
      assemblies: reading.assemblies.slice(0, RUN_CONTEXT_ASSEMBLY_MAX),
      complete:
        reading.walked &&
        reading.windows.length <= RUN_CONTEXT_WINDOW_MAX &&
        reading.assemblies.length <= RUN_CONTEXT_ASSEMBLY_MAX,
      composition:
        composition === null ? null : { ...composition, basis: "apportioned" },
    };
  };
}

export const runContextGetHandler = createRunContextGetHandler({
  ...defaultRunReadDeps(),
  modelCalls: readTachoModelCalls,
  windowFrames: readTachoWindowFrames,
});
