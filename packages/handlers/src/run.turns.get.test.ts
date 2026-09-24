// `get_run_turns` over in-memory stores: which path each kind of run takes,
// what it asks ClickHouse for, and what it answers. The rows' arithmetic is
// lib/run-turns.test.ts; the SQL against a real ClickHouse is
// run.turns.get.integration.test.ts.
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import {
  RUN_TURNS_MAX,
  runTurnsGet,
} from "@oxagen/oxagen/contracts/run.turns.get";
import type { TachoChainTurnFacts, TachoTurnGroup } from "@oxagen/telemetry";
import { describe, expect, it, vi } from "vitest";
import {
  createRunTurnsGetHandler,
  type RunTurnsGetDeps,
} from "./run.turns.get";
import {
  ctx,
  event,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  summary,
  tachoSession,
} from "./run.test-support";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const ROOT = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const CHILD = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";

const facts = (
  over: Partial<TachoChainTurnFacts> = {},
): TachoChainTurnFacts => ({
  sessionUuid: ROOT,
  turnStarts: [1, 40],
  turnIndexStarts: [],
  firstSeq: 0,
  firstObservedSeq: null,
  ...over,
});

const group = (over: Partial<TachoTurnGroup> = {}): TachoTurnGroup => ({
  sessionUuid: ROOT,
  turnKey: 1,
  firstSeq: 1,
  firstAt: "2026-09-11 09:00:01.000",
  frames: 10,
  modelCalls: 2,
  modelRequests: 0,
  modelResponses: 0,
  keyedToolCalls: 3,
  unkeyedToolRequests: 0,
  unkeyedToolCalls: 0,
  costMicros: 250,
  inputUncached: 40,
  cacheRead: 160,
  spawns: [],
  parentSessionUuid: null,
  subagentId: null,
  spawnToolUseId: null,
  ...over,
});

function harness(args: {
  children?: string[];
  facts?: TachoChainTurnFacts[];
  groups?: TachoTurnGroup[];
  events?: Parameters<typeof memoryEvents>[0];
  ledgerFrameCap?: number;
}) {
  const stores = memoryStores(
    [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
    [tachoSession({ publicId: TACHO_ID })],
  );
  const tachoTurnFacts = vi.fn<RunTurnsGetDeps["tachoTurnFacts"]>(() =>
    Promise.resolve(args.facts ?? [facts()]),
  );
  const tachoTurnGroups = vi.fn<RunTurnsGetDeps["tachoTurnGroups"]>(() =>
    Promise.resolve(args.groups ?? []),
  );
  const tachoChildSessions = vi.fn((_root: string) =>
    Promise.resolve(args.children ?? []),
  );
  const deps: RunTurnsGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id) =>
        Promise.resolve(id === LEDGER_ID ? summary() : null),
      readAttemptEventsSince: memoryEvents(args.events ?? []),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(ROOT, []),
    tachoChildSessions,
    tachoTurnFacts,
    tachoTurnGroups,
    ...(args.ledgerFrameCap === undefined
      ? {}
      : { ledgerFrameCap: args.ledgerFrameCap }),
  };
  return {
    turns: createRunTurnsGetHandler(deps),
    tachoTurnFacts,
    tachoTurnGroups,
    tachoChildSessions,
  };
}

const input = (runId: string) => runTurnsGet.input.parse({ runId });

describe("get_run_turns on a wrapped run", () => {
  it("reads the root and every subagent chain Postgres lists, in two ClickHouse reads", async () => {
    const h = harness({
      children: [CHILD],
      facts: [facts(), facts({ sessionUuid: CHILD, turnStarts: [0] })],
      groups: [
        group(),
        group({
          turnKey: 40,
          firstSeq: 40,
          firstAt: "2026-09-11 09:05:00.000",
          costMicros: null,
          inputUncached: null,
          cacheRead: null,
        }),
      ],
    });
    const out = await h.turns(input(TACHO_ID), ctx());
    expect(h.tachoChildSessions).toHaveBeenCalledWith(ROOT);
    expect(h.tachoTurnFacts).toHaveBeenCalledWith({
      sessionUuids: [ROOT, CHILD],
    });
    // A subagent's own turn_start opens no turn of the run.
    expect(h.tachoTurnGroups).toHaveBeenCalledWith({
      rootSessionUuid: ROOT,
      sessionUuids: [ROOT, CHILD],
      turnStarts: [1, 40],
      observedFrom: [],
    });
    expect(runTurnsGet.output.parse(out)).toEqual(out);
    expect(out.complete).toBe(true);
    expect(
      out.turns.map((t) => [t.turn, t.seq, t.cost?.micros ?? null]),
    ).toEqual([
      [1, "1", "250"],
      [2, "40", null],
    ]);
    expect(out.turns[1]?.cumulativeCost?.micros).toBe("250");
  });

  it("names each chain the proxy observed, and from which frame", async () => {
    const h = harness({
      children: [CHILD],
      facts: [
        facts({ firstObservedSeq: 7 }),
        facts({ sessionUuid: CHILD, turnStarts: [], firstObservedSeq: null }),
      ],
      groups: [group()],
    });
    await h.turns(input(TACHO_ID), ctx());
    expect(h.tachoTurnGroups.mock.calls[0]?.[0].observedFrom).toEqual([
      { sessionUuid: ROOT, seq: 7 },
    ]);
  });

  it("leaves out a listed chain that recorded no frame", async () => {
    const h = harness({ children: [CHILD], facts: [facts()] });
    await h.turns(input(TACHO_ID), ctx());
    expect(h.tachoTurnGroups.mock.calls[0]?.[0].sessionUuids).toEqual([ROOT]);
  });

  it("answers no turns, and makes no grouped read, for a run with no frames", async () => {
    const h = harness({ facts: [] });
    const out = await h.turns(input(TACHO_ID), ctx());
    expect(out).toEqual({ runId: TACHO_ID, turns: [], complete: true });
    expect(h.tachoTurnGroups).not.toHaveBeenCalled();
  });

  it("answers no turns when only a subagent chain recorded frames", async () => {
    const h = harness({
      children: [CHILD],
      facts: [facts({ sessionUuid: CHILD, turnStarts: [0] })],
    });
    const out = await h.turns(input(TACHO_ID), ctx());
    // A run's turns are the root's. A subagent chain alone opens none.
    expect(out).toEqual({ runId: TACHO_ID, turns: [], complete: true });
    expect(h.tachoTurnGroups).not.toHaveBeenCalled();
  });

  it("opens the turns where the index changes when the root recorded no turn_start", async () => {
    const h = harness({
      facts: [facts({ turnStarts: [], firstSeq: 0, turnIndexStarts: [2, 9] })],
    });
    await h.turns(input(TACHO_ID), ctx());
    expect(h.tachoTurnGroups.mock.calls[0]?.[0].turnStarts).toEqual([0, 9]);
  });

  it("binds one start past the cap and says a longer run's list is short", async () => {
    const starts = Array.from({ length: RUN_TURNS_MAX + 5 }, (_, i) => i * 2);
    const h = harness({ facts: [facts({ turnStarts: starts })] });
    const out = await h.turns(input(TACHO_ID), ctx());
    expect(h.tachoTurnGroups.mock.calls[0]?.[0].turnStarts).toHaveLength(
      RUN_TURNS_MAX + 1,
    );
    expect(out.complete).toBe(false);
  });

  it("is not_found for a run the workspace does not hold", async () => {
    const h = harness({});
    const err = await h
      .turns(input("tse_0000000000000000000000"), ctx())
      .catch((e: unknown) => e);
    expect(isHandlerError(err) && err.code).toBe("not_found");
    expect(h.tachoTurnFacts).not.toHaveBeenCalled();
  });
});

const LEDGER_EVENTS = [
  event(1, {
    eventType: "model.engine_call_started",
    payload: { model_call_id: "m1" },
  }),
  event(2, {
    eventType: "model.engine_call_completed",
    payload: { model_call_id: "m1" },
  }),
  event(3, {
    eventType: "tool.engine_call_started",
    payload: { tool_call_id: "t1" },
  }),
  event(4, {
    eventType: "tool.engine_call_completed",
    payload: { tool_call_id: "t1" },
  }),
];

describe("get_run_turns on a ledger run", () => {
  it("says the list stops short when the run has more frames than one read carries", async () => {
    const h = harness({ events: LEDGER_EVENTS, ledgerFrameCap: 2 });
    const out = await h.turns(input(LEDGER_ID), ctx());
    expect(out.complete).toBe(false);
    // The turn holds the two frames read, not the four recorded.
    expect(out.turns).toMatchObject([{ turn: 1, frames: 2, modelSteps: 1 }]);
  });

  it("reads the ledger and counts its frames, with no ClickHouse read", async () => {
    const h = harness({ events: LEDGER_EVENTS });
    const out = await h.turns(input(LEDGER_ID), ctx());
    expect(h.tachoTurnFacts).not.toHaveBeenCalled();
    expect(h.tachoChildSessions).not.toHaveBeenCalled();
    expect(runTurnsGet.output.parse(out)).toEqual(out);
    expect(out).toMatchObject({
      runId: LEDGER_ID,
      complete: true,
      turns: [
        {
          turn: 1,
          seq: "1",
          frames: 4,
          modelSteps: 1,
          toolSteps: 1,
          // The ledger records no cost on its frames.
          cost: null,
          cumulativeCost: null,
        },
      ],
    });
  });
});
