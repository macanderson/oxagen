// `get_run_context`: each model request's window, block by block, and the
// steering assembler's manifests (ADR-193; #3894).
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
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  RUN_CONTEXT_ASSEMBLY_MAX,
  RUN_CONTEXT_WINDOW_MAX,
  runContextGet,
  type RunContextGetOutput,
} from "@oxagen/oxagen/contracts/run.context.get";
import {
  type AttemptEventReadRecord,
  assemblyOf,
  isContextWindowEvent,
  isLaterLlmCallSighting,
  ledgerContextWindows,
  type RecordedAssembly,
  type RecordedWindow,
  tachoContextWindow,
  type TachoModelCallRow,
} from "@oxagen/run-ledger";
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
};

type Reading = {
  windows: RecordedWindow[];
  assemblies: RecordedAssembly[];
  unmeasured: number;
  /** False when the walk stopped at its cap. */
  walked: boolean;
};

/** A ledger run's windows, from its model-call and manifest events. */
async function ledgerReading(
  deps: RunContextGetDeps,
  runId: string,
): Promise<Reading> {
  const kept: AttemptEventReadRecord[] = [];
  let after = "0";
  let walked = 0;
  for (;;) {
    const want = Math.min(LEDGER_PAGE, LEDGER_EVENT_CAP - walked);
    if (want <= 0) return { ...ledgerContextWindows(kept), walked: false };
    const page = await deps.store.readAttemptEventsSince(runId, after, want);
    walked += page.length;
    for (const event of page)
      if (isContextWindowEvent(event.eventType)) kept.push(event);
    const last = page.at(-1);
    if (!last || page.length < want)
      return { ...ledgerContextWindows(kept), walked: true };
    after = last.runSeq;
  }
}

function manifestBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** A wrapped session's windows, from its `llm_call` and manifest rows. */
async function wrappedReading(
  deps: RunContextGetDeps,
  sessionUuid: string,
): Promise<Reading> {
  // One over the cap, so a full read is told apart from a cut one.
  const rows = await deps.modelCalls(sessionUuid, TACHO_ROW_CAP + 1);
  const read = rows.slice(0, TACHO_ROW_CAP);
  const windows: RecordedWindow[] = [];
  const assemblies: RecordedAssembly[] = [];
  const unmeasuredCalls: TachoModelCallRow[] = [];
  for (const row of read) {
    if (row.kind === "steering.manifest") {
      const assembly = assemblyOf(String(row.seq), manifestBody(row.body));
      if (assembly !== null) assemblies.push(assembly);
      continue;
    }
    const recorded = tachoContextWindow(row);
    if (recorded !== null) windows.push(recorded);
    else if (!isLaterLlmCallSighting(row)) unmeasuredCalls.push(row);
  }
  // A call the transcript reported first and the proxy measured second is
  // one call with a window, not an unmeasured one beside it. The two are
  // joined on the vendor's request id, so a first sighting that recorded
  // none stays counted as unmeasured: the read cannot show it is the same
  // call, and it does not guess.
  const measured = new Set(
    windows.flatMap((w) => (w.modelCallId === null ? [] : [w.modelCallId])),
  );
  const unmeasured = unmeasuredCalls.filter(
    (row) => row.requestId === "" || !measured.has(row.requestId),
  ).length;
  return {
    windows,
    assemblies,
    unmeasured,
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
    };
  };
}

export const runContextGetHandler = createRunContextGetHandler({
  ...defaultRunReadDeps(),
  modelCalls: readTachoModelCalls,
});
