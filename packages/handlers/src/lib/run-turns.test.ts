// The per-turn ledger's two builders: from frames (a ledger run, and the
// reference the ClickHouse path is checked against) and from ClickHouse's
// per-chain tallies (a wrapped run). The SQL that produces the tallies is
// checked against a real ClickHouse in run.turns.get.integration.test.ts.
import { ledgerFrame, type RunFrame, tachoFrame } from "@oxagen/run-ledger";
import type { TachoTurnGroup } from "@oxagen/telemetry";
import { describe, expect, it } from "vitest";
import { event, tachoRow } from "../run.test-support";
import {
  framesTurns,
  placeChains,
  tachoTurns,
  tachoTurnStarts,
} from "./run-turns";
import { withoutLateReports } from "./run-read";

const ROOT = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const CHILD_A = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const CHILD_B = "0192d4a8-7c1e-7a00-8000-0000000000c2";
const NESTED = "0192d4a8-7c1e-7a00-8000-0000000000c3";

const frame = (seq: number, over: Parameters<typeof tachoRow>[1] = {}) =>
  tachoFrame(tachoRow(seq, over));

/** A frame recorded on a subagent's chain. */
const sub = (
  session: string,
  seq: number,
  over: Parameters<typeof tachoRow>[1] = {},
) =>
  tachoFrame({
    ...tachoRow(seq, over),
    sessionUuid: session,
    rootSessionUuid: ROOT,
    parentSessionUuid: ROOT,
  });

const turnStart = (seq: number) =>
  frame(seq, { kind: "turn_start", toolName: "", toolStatus: "" });
const llm = (seq: number, over: Parameters<typeof tachoRow>[1] = {}) =>
  frame(seq, {
    kind: "llm_call",
    toolName: "",
    toolStatus: "",
    toolUseId: "",
    model: "claude-sonnet-5",
    provider: "anthropic",
    source: "hook",
    ...over,
  });
const requested = (seq: number, id: string) =>
  frame(seq, { kind: "tool_requested", toolUseId: id, toolStatus: "" });
const called = (seq: number, id: string) =>
  frame(seq, { kind: "tool_call", toolUseId: id });

describe("framesTurns", () => {
  it("counts each turn's steps, frames, cost and reported input, and the cost so far", () => {
    const frames: RunFrame[] = [
      frame(0, { kind: "agent_start", toolName: "", costUsdMicros: 5 }),
      turnStart(1),
      llm(2, {
        costUsdMicros: 40,
        body: JSON.stringify({ input_tokens: 100, cache_read_tokens: 300 }),
      }),
      requested(3, "tu_a"),
      requested(4, "tu_b"),
      called(5, "tu_a"),
      called(6, "tu_b"),
      // A second, digest-only copy of the same result is the same call.
      called(7, "tu_a"),
      turnStart(8),
      requested(9, "tu_c"),
      called(10, "tu_c"),
    ];
    const { turns, complete } = framesTurns(frames, 10);
    expect(complete).toBe(true);
    expect(turns).toEqual([
      {
        turn: 1,
        seq: "1",
        at: "2026-09-11T09:00:01.000Z",
        frames: 7,
        modelSteps: 1,
        toolSteps: 2,
        cost: { micros: "40", currency: "USD", basis: "client_attested" },
        // The agent's start, before the first turn, is already spent.
        cumulativeCost: {
          micros: "45",
          currency: "USD",
          basis: "client_attested",
        },
        tokens: { inputUncached: 100, cacheRead: 300 },
      },
      {
        turn: 2,
        seq: "8",
        at: "2026-09-11T09:00:08.000Z",
        frames: 3,
        modelSteps: 0,
        toolSteps: 1,
        // A turn no frame priced says so, and the cost so far holds.
        cost: null,
        cumulativeCost: {
          micros: "45",
          currency: "USD",
          basis: "client_attested",
        },
        tokens: { inputUncached: null, cacheRead: null },
      },
    ]);
  });

  it("counts a model call once however many sources reported it", () => {
    const dup = (source: string) => ({
      source,
      attrs: {
        "oxagen.llm_call_duplicate_of": "collector",
      } as Record<string, string>,
    });
    const frames = [
      turnStart(0),
      llm(1, {
        source: "collector",
        costUsdMicros: 90,
        body: JSON.stringify({ input_tokens: 10, request_id: "req_1" }),
      }),
      llm(2, {
        ...dup("transcript"),
        costUsdMicros: 90,
        body: JSON.stringify({ input_tokens: 10, request_id: "req_1" }),
      }),
      llm(3, {
        ...dup("otel_log"),
        costUsdMicros: 90,
        body: JSON.stringify({ input_tokens: 10, request_id: "req_1" }),
      }),
    ];
    const [only] = framesTurns(frames, 10).turns;
    expect(only).toMatchObject({
      frames: 4,
      modelSteps: 1,
      cost: { micros: "90" },
      tokens: { inputUncached: 10, cacheRead: null },
    });
  });

  it("counts a harness report on a chain the proxy was observing for nothing", () => {
    const observed = {
      source: "collector",
      fidelity: "proxy",
      attrs: { "oxagen.metering": "observed" } as Record<string, string>,
    };
    const frames = withoutLateReports([
      turnStart(0),
      llm(1, {
        ...observed,
        costUsdMicros: 70,
        body: JSON.stringify({ input_tokens: 7 }),
      }),
      llm(2, {
        costUsdMicros: 70,
        body: JSON.stringify({ input_tokens: 7 }),
      }),
    ]);
    const [only] = framesTurns(frames, 10).turns;
    expect(only).toMatchObject({
      modelSteps: 2,
      cost: { micros: "70" },
      tokens: { inputUncached: 7 },
    });
  });

  it("pairs a ledger run's intentions with their receipts, one step each", () => {
    const frames = [
      event(1, {
        eventType: "model.engine_call_started",
        payload: { model_call_id: "m1" },
      }),
      event(2, {
        eventType: "model.engine_call_completed",
        payload: { model_call_id: "m1", input_tokens: 20 },
      }),
      event(3, {
        eventType: "tool.engine_call_started",
        payload: { tool_call_id: "t1" },
      }),
      event(4, {
        eventType: "tool.engine_call_completed",
        payload: { tool_call_id: "t1" },
      }),
      event(5, { eventType: "tool.call_completed", payload: {} }),
    ].map(ledgerFrame);
    const { turns } = framesTurns(frames, 10);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      turn: 1,
      seq: "1",
      frames: 5,
      modelSteps: 1,
      toolSteps: 2,
      cost: null,
      cumulativeCost: null,
    });
  });

  it("counts a subagent's frames in the turn that spawned it", () => {
    const frames = [
      turnStart(0),
      requested(1, "tu_task"),
      // The subagent's own turn start is the prompt its parent handed it.
      sub(CHILD_A, 0, { kind: "turn_start", toolName: "" }),
      sub(CHILD_A, 1, { kind: "tool_call", toolUseId: "tu_a" }),
      called(2, "tu_task"),
      turnStart(3),
    ];
    const { turns } = framesTurns(frames, 10);
    expect(turns.map((t) => [t.turn, t.frames, t.toolSteps])).toEqual([
      [1, 5, 2],
      [2, 1, 0],
    ]);
  });

  it("opens a turn at its first frame on the run's own chain, not a subagent's spliced ahead of it", () => {
    const frames = [
      // A subagent that began before the run's first frame, seq 7 of its own chain.
      sub(CHILD_A, 7, { ts: "2026-09-11 08:59:55.000", turnSeq: null }),
      frame(3, { turnSeq: 1 }),
      frame(4, { turnSeq: 2 }),
    ];
    const { turns } = framesTurns(frames, 10);
    expect(turns.map((t) => [t.turn, t.seq, t.at, t.frames])).toEqual([
      [1, "3", "2026-09-11T09:00:03.000Z", 2],
      [2, "4", "2026-09-11T09:00:04.000Z", 1],
    ]);
  });

  it("stops at the cap and says the list is short", () => {
    const frames = [turnStart(0), turnStart(1), turnStart(2)];
    const { turns, complete } = framesTurns(frames, 2);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
    expect(complete).toBe(false);
  });
});

describe("tachoTurnStarts", () => {
  const facts = (over: Record<string, unknown>) => ({
    sessionUuid: ROOT,
    turnStarts: [],
    turnIndexStarts: [],
    firstSeq: 0,
    firstObservedSeq: null,
    ...over,
  });

  it("opens the turns at the turn_start frames when the root recorded any", () => {
    expect(tachoTurnStarts(facts({ turnStarts: [2, 9] }))).toEqual({
      starts: [2, 9],
      boundaries: "turn_start",
    });
  });

  it("opens them where the turn index changes when it recorded none", () => {
    // The first frame opens turn 1; the first index value opens nothing of
    // its own, and each later one opens a turn.
    expect(
      tachoTurnStarts(facts({ firstSeq: 0, turnIndexStarts: [3, 20, 41] })),
    ).toEqual({ starts: [0, 20, 41], boundaries: "turn_index" });
    expect(tachoTurnStarts(facts({ firstSeq: 5 }))).toEqual({
      starts: [5],
      boundaries: "turn_index",
    });
  });

  it("answers no turns for a root with no frames", () => {
    expect(tachoTurnStarts(undefined).starts).toEqual([]);
  });
});

const group = (over: Partial<TachoTurnGroup>): TachoTurnGroup => ({
  sessionUuid: ROOT,
  turnKey: 0,
  firstSeq: 0,
  firstAt: "2026-09-11 09:00:00.000",
  frames: 1,
  modelCalls: 0,
  modelRequests: 0,
  modelResponses: 0,
  keyedToolCalls: 0,
  unkeyedToolRequests: 0,
  unkeyedToolCalls: 0,
  costMicros: null,
  inputUncached: null,
  cacheRead: null,
  spawns: [],
  parentSessionUuid: null,
  subagentId: null,
  spawnToolUseId: null,
  ...over,
});

const chain = (id: string, over: Partial<TachoTurnGroup> = {}) =>
  group({
    sessionUuid: id,
    turnKey: null,
    parentSessionUuid: ROOT,
    ...over,
  });

describe("placeChains", () => {
  const rootTurns = [
    {
      index: 1,
      at: Date.parse("2026-09-11T09:00:00Z"),
      spawns: [{ seq: 2, toolUseId: "tu_task_a", subagentId: null }],
    },
    {
      index: 2,
      at: Date.parse("2026-09-11T09:10:00Z"),
      spawns: [{ seq: 30, toolUseId: null, subagentId: "agent_b" }],
    },
  ];

  it("places a chain at the spawn naming its tool call, then its agent id", () => {
    const placed = placeChains({
      chains: [
        chain(CHILD_A, { spawnToolUseId: "tu_task_a" }),
        chain(CHILD_B, { subagentId: "agent_b" }),
      ],
      rootTurns,
      beforeSpawns: [],
    });
    expect(placed.get(CHILD_A)).toBe(1);
    expect(placed.get(CHILD_B)).toBe(2);
  });

  it("places a chain no spawn names in the turn in progress when it began", () => {
    const placed = placeChains({
      chains: [
        chain(CHILD_A, { firstAt: "2026-09-11 09:12:00.000" }),
        chain(CHILD_B, { firstAt: "2026-09-11 08:59:00.000" }),
      ],
      rootTurns: rootTurns.map((t) => ({ ...t, spawns: [] })),
      beforeSpawns: [],
    });
    expect(placed.get(CHILD_A)).toBe(2);
    // Before the first turn opened: in no turn.
    expect(placed.get(CHILD_B)).toBeNull();
  });

  it("gives a spawn two chains could answer to the one that began first, whatever their ids", () => {
    const placed = placeChains({
      chains: [
        chain(CHILD_A, {
          spawnToolUseId: "tu_task_a",
          firstAt: "2026-09-11 09:12:00.000",
        }),
        chain(CHILD_B, {
          spawnToolUseId: "tu_task_a",
          firstAt: "2026-09-11 09:00:30.000",
        }),
      ],
      rootTurns,
      beforeSpawns: [],
    });
    // CHILD_A sorts first by id, but CHILD_B began first.
    expect(placed.get(CHILD_B)).toBe(1);
    // The spawn is taken, so CHILD_A is placed by when it began: in turn 2.
    expect(placed.get(CHILD_A)).toBe(2);
  });

  it("breaks a tie on when two chains began by the lower session id", () => {
    const placed = placeChains({
      chains: [
        chain(CHILD_B, { spawnToolUseId: "tu_task_a" }),
        chain(CHILD_A, {
          spawnToolUseId: "tu_task_a",
          firstAt: "2026-09-11 09:00:00.000",
        }),
      ],
      rootTurns: rootTurns.map((t) => ({
        ...t,
        at: t.index === 2 ? Date.parse("2026-09-11T08:59:00Z") : t.at,
      })),
      beforeSpawns: [],
    });
    expect(placed.get(CHILD_A)).toBe(1);
  });

  it("gives a chain one spawn even when two spawns name it", () => {
    const placed = placeChains({
      chains: [
        chain(CHILD_A, { subagentId: "agent_r" }),
        chain(CHILD_B, {
          subagentId: "agent_r",
          firstAt: "2026-09-11 09:00:30.000",
        }),
      ],
      rootTurns: [
        {
          index: 1,
          at: Date.parse("2026-09-11T08:59:00Z"),
          spawns: [{ seq: 2, toolUseId: null, subagentId: "agent_r" }],
        },
        {
          index: 2,
          at: Date.parse("2026-09-11T09:10:00Z"),
          spawns: [{ seq: 30, toolUseId: null, subagentId: "agent_r" }],
        },
      ],
      beforeSpawns: [],
    });
    // Both chains began in turn 1, so only the spawns can put one in turn 2.
    expect(placed.get(CHILD_A)).toBe(1);
    expect(placed.get(CHILD_B)).toBe(2);
  });

  it("falls back to the agent id when the spawn's tool call names no chain", () => {
    const placed = placeChains({
      chains: [chain(CHILD_B, { subagentId: "agent_b" })],
      rootTurns: rootTurns.map((t) =>
        t.index === 2
          ? {
              ...t,
              spawns: [
                { seq: 30, toolUseId: "tu_missing", subagentId: "agent_b" },
              ],
            }
          : t,
      ),
      beforeSpawns: [],
    });
    // Placed by when it began, it would be turn 1.
    expect(placed.get(CHILD_B)).toBe(2);
  });

  it("places a chain spawned by a subagent in its parent's turn", () => {
    const placed = placeChains({
      chains: [
        chain(CHILD_B, { subagentId: "agent_b" }),
        chain(NESTED, {
          parentSessionUuid: CHILD_B,
          spawnToolUseId: "tu_task_a",
        }),
      ],
      rootTurns,
      beforeSpawns: [],
    });
    // The root's spawn of tu_task_a is not the nested chain's: it sits inside
    // CHILD_B, which turn 2 spawned.
    expect(placed.get(NESTED)).toBe(2);
  });

  it("places chains caught in a cycle of recorded parents in the last turn", () => {
    const placed = placeChains({
      chains: [
        chain(CHILD_A, { parentSessionUuid: CHILD_B }),
        chain(CHILD_B, { parentSessionUuid: CHILD_A }),
      ],
      rootTurns,
      beforeSpawns: [],
    });
    expect(placed.get(CHILD_A)).toBe(2);
    expect(placed.get(CHILD_B)).toBe(2);
  });

  it("places a chain spawned before the first turn in no turn", () => {
    const placed = placeChains({
      chains: [chain(CHILD_A, { spawnToolUseId: "tu_early" })],
      rootTurns,
      beforeSpawns: [{ seq: 0, toolUseId: "tu_early", subagentId: null }],
    });
    expect(placed.get(CHILD_A)).toBeNull();
  });
});

describe("tachoTurns", () => {
  it("adds each chain's tallies to the turn it falls in", () => {
    const { turns, complete } = tachoTurns({
      rootSessionUuid: ROOT,
      starts: [1, 40],
      boundaries: "turn_start",
      cap: 10,
      groups: [
        group({ turnKey: null, firstSeq: 0, frames: 1, costMicros: 5 }),
        group({
          turnKey: 1,
          firstSeq: 1,
          firstAt: "2026-09-11 09:00:01.000",
          frames: 30,
          modelCalls: 4,
          keyedToolCalls: 3,
          costMicros: 100,
          inputUncached: 10,
          cacheRead: 90,
          spawns: [{ seq: 5, toolUseId: "tu_task", subagentId: null }],
        }),
        group({
          turnKey: 40,
          firstSeq: 40,
          firstAt: "2026-09-11 09:05:00.000",
          frames: 2,
        }),
        chain(CHILD_A, {
          spawnToolUseId: "tu_task",
          frames: 12,
          modelCalls: 2,
          modelRequests: 1,
          keyedToolCalls: 1,
          unkeyedToolRequests: 2,
          unkeyedToolCalls: 1,
          costMicros: 20,
          inputUncached: 5,
        }),
      ],
    });
    expect(complete).toBe(true);
    expect(turns).toEqual([
      {
        turn: 1,
        seq: "1",
        at: "2026-09-11T09:00:01.000Z",
        frames: 42,
        // 4 on the root; 2 single calls and one unpaired request on the subagent.
        modelSteps: 7,
        // 3 on the root; one keyed and two unkeyed requests on the subagent.
        toolSteps: 6,
        cost: { micros: "120", currency: "USD", basis: "client_attested" },
        cumulativeCost: {
          micros: "125",
          currency: "USD",
          basis: "client_attested",
        },
        tokens: { inputUncached: 15, cacheRead: 90 },
      },
      {
        turn: 2,
        seq: "40",
        at: "2026-09-11T09:05:00.000Z",
        frames: 2,
        modelSteps: 0,
        toolSteps: 0,
        cost: null,
        cumulativeCost: {
          micros: "125",
          currency: "USD",
          basis: "client_attested",
        },
        tokens: { inputUncached: null, cacheRead: null },
      },
    ]);
  });

  it("counts a subagent spawned before the first turn in the cost so far, in no turn's row", () => {
    const { turns } = tachoTurns({
      rootSessionUuid: ROOT,
      starts: [1],
      boundaries: "turn_start",
      cap: 10,
      groups: [
        group({
          turnKey: null,
          frames: 2,
          costMicros: 5,
          spawns: [{ seq: 0, toolUseId: "tu_early", subagentId: null }],
        }),
        group({ turnKey: 1, firstSeq: 1, frames: 3, costMicros: 100 }),
        chain(CHILD_A, {
          spawnToolUseId: "tu_early",
          frames: 4,
          costMicros: 20,
        }),
      ],
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      frames: 3,
      cost: { micros: "100" },
      cumulativeCost: { micros: "125" },
    });
  });

  it("pairs a request with a response on its own chain, never with one on another", () => {
    const { turns } = tachoTurns({
      rootSessionUuid: ROOT,
      starts: [0],
      boundaries: "turn_start",
      cap: 10,
      groups: [
        group({
          turnKey: 0,
          modelRequests: 1,
          unkeyedToolRequests: 1,
          spawns: [{ seq: 1, toolUseId: "tu_task", subagentId: null }],
        }),
        chain(CHILD_A, {
          spawnToolUseId: "tu_task",
          modelResponses: 1,
          unkeyedToolCalls: 1,
        }),
      ],
    });
    // One unanswered request on the root and one lone response on the
    // subagent are two calls, not one.
    expect(turns[0]).toMatchObject({ modelSteps: 2, toolSteps: 2 });
  });

  it("puts a chain placed before every root frame in turn 1 when the turns follow the index", () => {
    const groups = [
      group({ turnKey: 0, firstSeq: 0, frames: 3 }),
      chain(CHILD_A, { firstAt: "2026-09-11 08:00:00.000", frames: 4 }),
    ];
    const byIndex = tachoTurns({
      rootSessionUuid: ROOT,
      starts: [0],
      boundaries: "turn_index",
      cap: 10,
      groups,
    });
    expect(byIndex.turns[0]?.frames).toBe(7);
    const byStart = tachoTurns({
      rootSessionUuid: ROOT,
      starts: [0],
      boundaries: "turn_start",
      cap: 10,
      groups,
    });
    expect(byStart.turns[0]?.frames).toBe(3);
  });

  it("keeps the turns up to the cap and says the list is short", () => {
    const { turns, complete } = tachoTurns({
      rootSessionUuid: ROOT,
      starts: [0, 10, 20],
      boundaries: "turn_start",
      cap: 2,
      groups: [
        group({ turnKey: 0 }),
        group({ turnKey: 10, firstSeq: 10 }),
        group({ turnKey: 20, firstSeq: 20 }),
      ],
    });
    expect(turns.map((t) => t.seq)).toEqual(["0", "10"]);
    expect(complete).toBe(false);
  });
});
