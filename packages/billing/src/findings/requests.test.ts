import { describe, expect, it } from "vitest";
import type { RunTotalsRecord } from "../cost-rollup";
import { buildRunViews } from "./requests";
import type {
  DetectInput,
  PricedRequestFrame,
  ToolCallObservation,
} from "./shared";

const START = new Date("2026-09-30T10:00:00.000Z");
const RUN_ID = "tse_0000000000000000000001";
const CHILD = "00000000-0000-4000-8000-0000000000cc";

/** The run record the view holds; placement reads only its id. */
const RUN = { runId: RUN_ID } as RunTotalsRecord;

/** A model call on the run's own chain `at` seconds in. */
function frame(
  at: number,
  over: Partial<PricedRequestFrame> = {},
): PricedRequestFrame {
  const when = new Date(START.getTime() + at * 1_000);
  return {
    key: `${when.toISOString()}#0`,
    at: when,
    costMicros: 120_000n,
    tokens: 22_000,
    basis: "gateway_observed",
    sessionUuid: null,
    model: "claude-sonnet-5",
    provider: "anthropic",
    ...over,
  };
}

/** A tool call that finished `at` seconds in. */
function call(
  at: number,
  over: Partial<ToolCallObservation> = {},
): ToolCallObservation {
  return {
    runId: RUN_ID,
    at: new Date(START.getTime() + at * 1_000),
    seq: at,
    tool: "Read",
    inputDigest: `in-${at}`,
    outputDigest: `out-${at}`,
    isMutating: false,
    resultTokens: null,
    sessionUuid: null,
    ...over,
  };
}

function input(
  toolCalls: ToolCallObservation[],
  frames: PricedRequestFrame[],
): DetectInput {
  return {
    window: { start: START, end: new Date(START.getTime() + 3_600_000) },
    toolWindowStart: START,
    runs: [RUN],
    toolCalls,
    decidedSince: new Map(),
    frames: new Map([[RUN_ID, frames]]),
  };
}

/** Each request of the run's one view, as its frame's key and its calls' tools. */
function placed(i: DetectInput): Array<[string | null, string[]]> {
  const [view] = buildRunViews(i, new Map([[RUN_ID, RUN]]));
  return (view?.requests ?? []).map((r) => [
    r.frame?.key ?? null,
    r.calls.map((c) => `${c.call.tool}@${c.call.seq}`),
  ]);
}

describe("request placement", () => {
  it("places a tool call under the latest model call at or before it", () => {
    const first = frame(2);
    const second = frame(10);
    expect(placed(input([call(5), call(12)], [first, second]))).toEqual([
      [first.key, ["Read@5"]],
      [second.key, ["Read@12"]],
    ]);
  });

  // Lane F32: while the parent waits on a subagent, the model proxy sends
  // cache keep-alives on the parent's chain. A hook seals the parent's Task
  // call when the subagent ends, after every keep-alive, and the subagent's
  // own calls fall back to the run's latest frame. A keep-alive made none of
  // those calls.
  it("places the call that started a subagent, and the subagent's calls, under the parent's request and never under a cache keep-alive", () => {
    const parent = frame(2);
    const keepAlives = [
      frame(272, { cacheKeepAlive: true, tokens: 60_010, costMicros: 18_030n }),
      frame(542, { cacheKeepAlive: true, tokens: 60_010, costMicros: 18_030n }),
    ];
    const subagentCall = call(300, { sessionUuid: CHILD, tool: "Grep" });
    const task = call(720, { tool: "Task", isMutating: null });
    expect(
      placed(input([subagentCall, task], [parent, ...keepAlives])),
    ).toEqual([[parent.key, ["Grep@300", "Task@720"]]]);
  });

  // #4506 pass 4: a chain numbers its model calls and tool calls from one
  // counter, so a call of a frame's own millisecond and chain is placed by
  // seq, whatever order the store returns the frames in.
  it("places a call of two model calls' own millisecond and chain by seq", () => {
    const first = frame(2, { key: "first", seq: 10 });
    const second = frame(2, { key: "second", seq: 12 });
    const calls = [call(2, { seq: 11 }), call(2, { seq: 13, inputDigest: "x" })];
    const expected = [
      ["first", ["Read@11"]],
      ["second", ["Read@13"]],
    ];
    expect(placed(input(calls, [second, first]))).toEqual(expected);
    expect(placed(input(calls, [first, second]))).toEqual(expected);
  });

  // #4506 pass 5: the proxy records a subagent's model call on the root
  // chain (ADR-168).
  it("places a subagent's call under a root chain frame later than its own chain's", () => {
    const own = frame(2, { key: "own", sessionUuid: CHILD });
    const proxied = frame(5, { key: "proxied" });
    expect(
      placed(
        input(
          [call(3, { sessionUuid: CHILD }), call(6, { sessionUuid: CHILD })],
          [own, proxied],
        ),
      ),
    ).toEqual([
      ["own", ["Read@3"]],
      ["proxied", ["Read@6"]],
    ]);
  });

  // #4506 pass 7: a model call that named no model bounds a request that
  // nothing prices.
  it("starts a request with no price at a model call that named no model", () => {
    const priced = frame(2);
    const modelless = frame(6, {
      key: "modelless",
      costMicros: null,
      basis: null,
      model: "",
      noModel: true,
    });
    const i: DetectInput = {
      ...input([call(3), call(8)], [priced]),
      modellessFrames: new Map([[RUN_ID, [modelless]]]),
    };
    expect(placed(i)).toEqual([
      [priced.key, ["Read@3"]],
      ["modelless", ["Read@8"]],
    ]);
    const [view] = buildRunViews(i, new Map([[RUN_ID, RUN]]));
    expect(view?.requests?.[1]?.frame).toMatchObject({
      costMicros: null,
      noModel: true,
    });
    // Without it, the call joins the priced request before it.
    expect(placed(input([call(3), call(8)], [priced]))).toEqual([
      [priced.key, ["Read@3", "Read@8"]],
    ]);
  });

  it("keeps a keep-alive out of placement when it shares an instant with the parent's request", () => {
    const parent = frame(2);
    const keepAlive = frame(2, {
      key: `${new Date(START.getTime() + 2_000).toISOString()}#1`,
      cacheKeepAlive: true,
    });
    expect(placed(input([call(3)], [parent, keepAlive]))).toEqual([
      [parent.key, ["Read@3"]],
    ]);
  });
});
