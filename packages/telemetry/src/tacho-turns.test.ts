// The two reads behind `get_run_turns`, against a mocked `chSelect`: the
// query each sends, the parameters it binds, and how each answer row maps.
// These pin the query's text, not what it counts. What it counts is checked
// against a real ClickHouse in
// packages/handlers/src/run.turns.get.integration.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const chSelect = vi.fn(
  async (_q: { query: string; params?: Record<string, unknown> }) => ({
    data: [] as unknown[],
  }),
);

vi.mock("./tenant", () => ({
  chSelect: (q: { query: string; params?: Record<string, unknown> }) =>
    chSelect(q),
}));

import { selectTachoTurnFacts, selectTachoTurnGroups } from "./tacho-turns";

const ROOT = "0b0e0000-0000-4000-8000-0000000000aa";
const CHILD = "0b0e0000-0000-4000-8000-000000000100";

beforeEach(() => {
  chSelect.mockReset();
  chSelect.mockResolvedValue({ data: [] });
});

function lastQuery(): { query: string; params: Record<string, unknown> } {
  const call = chSelect.mock.calls.at(-1)?.[0];
  if (call === undefined) throw new Error("no query was sent");
  return { query: call.query, params: call.params ?? {} };
}

describe("selectTachoTurnFacts", () => {
  it("sends no query for a run with no chains", async () => {
    expect(await selectTachoTurnFacts({ sessionUuids: [] })).toEqual([]);
    expect(chSelect).not.toHaveBeenCalled();
  });

  it("reads each chain's turn starts, index starts and first observed call in one grouped query", async () => {
    chSelect.mockResolvedValue({
      data: [
        {
          chain: ROOT,
          starts: ["0", "62", "124"],
          index_starts: [
            [1, 2, 3],
            ["1", "63", "125"],
          ],
          first_seq: "0",
          observed: "4",
          first_observed: "70",
        },
        {
          chain: CHILD,
          starts: [],
          index_starts: [[], []],
          first_seq: "0",
          observed: "0",
          first_observed: "0",
        },
      ],
    });
    const facts = await selectTachoTurnFacts({ sessionUuids: [ROOT, CHILD] });
    expect(facts).toEqual([
      {
        sessionUuid: ROOT,
        turnStarts: [0, 62, 124],
        turnIndexStarts: [1, 63, 125],
        firstSeq: 0,
        firstObservedSeq: 70,
      },
      {
        sessionUuid: CHILD,
        turnStarts: [],
        turnIndexStarts: [],
        firstSeq: 0,
        // `minIf` answers 0 when nothing matched; the count says nothing did.
        firstObservedSeq: null,
      },
    ]);
    const { query, params } = lastQuery();
    expect(query).toMatch(/FROM tacho_events FINAL\s+WHERE session_uuid IN/);
    expect(query).toMatch(/GROUP BY chain/);
    expect(query).toContain("source = 'collector' AND fidelity = 'proxy'");
    expect(params).toMatchObject({
      sessionUuids: [ROOT, CHILD],
      meteringAttr: "oxagen.metering",
      observed: "observed",
    });
  });

  it("reads each turn index's first seq once and in seq order, and a chain with no index as none", async () => {
    chSelect.mockResolvedValue({
      data: [
        {
          chain: ROOT,
          starts: [],
          // A minMap answers per key, in key order, and two keys can share a
          // seq. tachoTurnStarts drops the first, so the order matters.
          index_starts: [
            [3, 1, 2],
            ["125", "1", "1"],
          ],
          first_seq: "0",
          observed: "0",
          first_observed: "0",
        },
        {
          chain: CHILD,
          starts: [],
          index_starts: null,
          first_seq: "4",
          observed: "0",
          first_observed: "0",
        },
      ],
    });
    const [root, child] = await selectTachoTurnFacts({
      sessionUuids: [ROOT, CHILD],
    });
    expect(root?.turnIndexStarts).toEqual([1, 125]);
    expect(child?.turnIndexStarts).toEqual([]);
    expect(child?.firstSeq).toBe(4);
  });
});

const group = (over: Record<string, unknown> = {}) => ({
  chain: ROOT,
  turn_key: "0",
  first_seq: "0",
  first_at: "2026-09-20 09:00:00.000",
  frames: "62",
  model_calls: "20",
  model_requests: "0",
  model_responses: "0",
  keyed_tools: "20",
  unkeyed_requests: "0",
  unkeyed_calls: "0",
  cost_micros: "30000",
  priced: "20",
  input_uncached: "1834",
  input_reported: "20",
  cache_read: "12000",
  cache_reported: "20",
  spawns: [],
  parent: null,
  subagent_id: "",
  spawn_tool_use_id: "",
  ...over,
});

describe("selectTachoTurnGroups", () => {
  const args = {
    rootSessionUuid: ROOT,
    sessionUuids: [ROOT, CHILD],
    turnStarts: [0, 62],
    observedFrom: [{ sessionUuid: CHILD, seq: 3 }],
  };

  it("sends no query when the run has no chain or no turn", async () => {
    expect(await selectTachoTurnGroups({ ...args, sessionUuids: [] })).toEqual(
      [],
    );
    expect(await selectTachoTurnGroups({ ...args, turnStarts: [] })).toEqual(
      [],
    );
    expect(chSelect).not.toHaveBeenCalled();
  });

  it("groups by chain and the turn start at or below each root frame", async () => {
    await selectTachoTurnGroups(args);
    const { query, params } = lastQuery();
    expect(query).toContain(
      "toInt64(roundDown(seq, {turnStarts:Array(UInt64)}))",
    );
    expect(query).toMatch(/GROUP BY chain, turn_key/);
    expect(params).toMatchObject({
      rootSessionUuid: ROOT,
      sessionUuids: [ROOT, CHILD],
      turnStarts: [0, 62],
      firstStart: 0,
      observedChains: [CHILD],
      observedSeqs: [3],
      duplicateAttr: "oxagen.llm_call_duplicate_of",
      sources: ["otel_log", "collector", "hook", "transcript"],
    });
  });

  it("counts neither a later sighting's cost nor a late harness report's", async () => {
    await selectTachoTurnGroups(args);
    const { query } = lastQuery();
    // The priced rule refuses both, and the model-call count refuses the
    // later sighting, so a call reported three times is one call.
    expect(query).toMatch(
      /sumIf\(cost_usd_micros, cost_usd_micros IS NOT NULL AND NOT \(kind = 'llm_call' AND attrs\[\{duplicateAttr:String\}\] != ''\) AND NOT \(kind = 'llm_call' AND NOT/,
    );
    expect(query).toMatch(
      /countIf\(kind = 'llm_call' AND NOT \(kind = 'llm_call' AND attrs\[\{duplicateAttr:String\}\] != ''\)\) AS model_calls/,
    );
    expect(query).toContain(
      "seq > {observedSeqs:Array(UInt64)}[indexOf({observedChains:Array(String)}, toString(session_uuid))]",
    );
  });

  it("maps a root turn, the frames before the first turn, and a subagent chain", async () => {
    chSelect.mockResolvedValue({
      data: [
        group(),
        group({
          turn_key: "-1",
          frames: "3",
          model_calls: "0",
          keyed_tools: "0",
          cost_micros: null,
          priced: "0",
          input_uncached: null,
          input_reported: "0",
          cache_read: null,
          cache_reported: "0",
        }),
        group({
          chain: CHILD,
          turn_key: "-1",
          first_seq: "0",
          frames: "12",
          spawns: [["4", "toolu_nested", "agent_2"]],
          parent: ROOT,
          subagent_id: "agent_1",
          spawn_tool_use_id: "toolu_sub_1",
          cost_micros: "0",
          priced: "2",
          input_uncached: "0",
          input_reported: "0",
        }),
      ],
    });
    const groups = await selectTachoTurnGroups(args);
    expect(groups[0]).toEqual({
      sessionUuid: ROOT,
      turnKey: 0,
      firstSeq: 0,
      firstAt: "2026-09-20 09:00:00.000",
      frames: 62,
      modelCalls: 20,
      modelRequests: 0,
      modelResponses: 0,
      keyedToolCalls: 20,
      unkeyedToolRequests: 0,
      unkeyedToolCalls: 0,
      costMicros: 30000,
      inputUncached: 1834,
      cacheRead: 12000,
      spawns: [],
      parentSessionUuid: null,
      subagentId: null,
      spawnToolUseId: null,
    });
    expect(groups[1]).toMatchObject({
      turnKey: null,
      costMicros: null,
      inputUncached: null,
      cacheRead: null,
    });
    expect(groups[2]).toMatchObject({
      sessionUuid: CHILD,
      turnKey: null,
      // Two priced records that summed to zero cost zero, not "not recorded".
      costMicros: 0,
      // The sum ClickHouse answers for a class nobody reported is not a zero.
      inputUncached: null,
      spawns: [{ seq: 4, toolUseId: "toolu_nested", subagentId: "agent_2" }],
      parentSessionUuid: ROOT,
      subagentId: "agent_1",
      spawnToolUseId: "toolu_sub_1",
    });
  });

  it("reads a spawn that recorded no tool call or agent id as null", async () => {
    chSelect.mockResolvedValue({
      data: [group({ spawns: [["9", "", ""]] })],
    });
    const [only] = await selectTachoTurnGroups(args);
    expect(only?.spawns).toEqual([
      { seq: 9, toolUseId: null, subagentId: null },
    ]);
  });
});
