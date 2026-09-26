// `get_run_turns`: a run's per-turn ledger over every frame it recorded
// (Mission Control spec §12.9; #4067). The contract states what each row
// counts; lib/run-turns.ts counts it.
//
// A wrapped run is counted in ClickHouse, in two reads whatever its length:
// where each chain's turns open and where the proxy began observing it, then
// every frame grouped by chain and turn. The chains are the root and the
// subagent chains Postgres lists under it (`tacho_sessions_root_idx`), the
// same list the transcript reads, so a subagent the transcript shows is a
// subagent this counts. A ledger run is read from the ledger, and its steps
// are the ones the transcript's `steps` zoom folds (ADR-182).
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  RUN_TURNS_MAX,
  runTurnsGet,
  type RunTurnsGetOutput,
} from "@oxagen/oxagen/contracts/run.turns.get";
import { UNKEYED_TOOL_PAIRING } from "@oxagen/run-ledger";
import { selectTachoTurnFacts, selectTachoTurnGroups } from "@oxagen/telemetry";
import {
  defaultRunReadDeps,
  readAllFrames,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";
import { framesTurns, tachoTurns, tachoTurnStarts } from "./lib/run-turns";

/**
 * The most frames a ledger run is read to. The ledger reads 500 frames a
 * query, so this bounds the read at 100 queries. A run past it answers the
 * turns of its first 50,000 frames and says the list stops short.
 */
const LEDGER_FRAME_CAP = 50_000;

export type RunTurnsGetDeps = RunReadDeps & {
  tachoTurnFacts: typeof selectTachoTurnFacts;
  tachoTurnGroups: typeof selectTachoTurnGroups;
  /** The ledger read's frame cap. Tests set it low. */
  ledgerFrameCap?: number;
};

export function createRunTurnsGetHandler(
  deps: RunTurnsGetDeps,
): CapabilityHandler<typeof runTurnsGet> {
  return async (input, ctx): Promise<RunTurnsGetOutput> => {
    const run = await resolveRun(deps, ctx, input.runId);
    if (run.source === "ledger") {
      const read = await readAllFrames(
        deps,
        run,
        deps.ledgerFrameCap ?? LEDGER_FRAME_CAP,
      );
      const ledger = framesTurns(read.frames, RUN_TURNS_MAX);
      return {
        runId: input.runId,
        turns: ledger.turns,
        complete: ledger.complete && read.complete,
      };
    }
    const children =
      deps.tachoChildSessions === undefined
        ? []
        : await deps.tachoChildSessions(run.sessionUuid);
    const facts = await deps.tachoTurnFacts({
      sessionUuids: [run.sessionUuid, ...children],
    });
    const { starts, boundaries } = tachoTurnStarts(
      facts.find((f) => f.sessionUuid === run.sessionUuid),
    );
    if (starts.length === 0)
      return { runId: input.runId, turns: [], complete: true };
    // One start past the cap is enough to tell a longer run from one that
    // fits, and it keeps the list the query binds bounded.
    const kept = starts.slice(0, RUN_TURNS_MAX + 1);
    const groups = await deps.tachoTurnGroups({
      rootSessionUuid: run.sessionUuid,
      sessionUuids: facts.map((f) => f.sessionUuid),
      turnStarts: kept,
      observedFrom: facts.flatMap((f) =>
        f.firstObservedSeq === null
          ? []
          : [{ sessionUuid: f.sessionUuid, seq: f.firstObservedSeq }],
      ),
      // The fold's rule 3, so the query pairs unkeyed tool halves as the
      // transcript does (#4308, ADR-191).
      pairing: UNKEYED_TOOL_PAIRING,
    });
    return {
      runId: input.runId,
      ...tachoTurns({
        rootSessionUuid: run.sessionUuid,
        starts: kept,
        boundaries,
        groups,
        cap: RUN_TURNS_MAX,
      }),
    };
  };
}

export const runTurnsGetHandler = createRunTurnsGetHandler({
  ...defaultRunReadDeps(),
  tachoTurnFacts: selectTachoTurnFacts,
  tachoTurnGroups: selectTachoTurnGroups,
});
