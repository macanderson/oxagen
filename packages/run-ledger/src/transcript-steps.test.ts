// The one transcript fold (ADR-182). The step rules here were the Run page's
// (the browser fold in `apps/app/src/features/run/transcript-model.ts`, since
// removed) and the server's (run-frames.test.ts) until the two folds became
// this one; their cases are ported so the behaviour each pinned stays pinned
// where the rule now lives.
import { describe, expect, it } from "vitest";
import { NO_BODY } from "./frame-body";
import {
  frameKey,
  ledgerFrame,
  type RunFrame,
  stepKind,
  tachoFrame,
  type TachoFrameRowLike,
  TRANSCRIPT_KINDS,
} from "./run-frames";
import type { AttemptEventReadRecord } from "./run-store";
import {
  filterFoldsByKind,
  foldTranscript,
  frameCounts,
  frameFolds,
  markWords,
  wordsDigest,
  RECALL_ITEM_MAX,
  type RecallBody,
  recallOf,
  stepFolds,
  toolUseClaimer,
  type TranscriptFold,
  type TranscriptRecallBody,
  transcriptCounts,
  turnFolds,
  wordsHalf,
} from "./transcript-steps";

const ROOT = "0192d4a8-7c1e-7a00-8000-00000000000a";
const SUB = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const NESTED = "0192d4a8-7c1e-7a00-8000-0000000000c3";

const at = (second: number) =>
  `2026-09-11 09:00:${String(second).padStart(2, "0")}.000`;

function row(
  seq: number,
  kind: string,
  over: Partial<TachoFrameRowLike> = {},
): TachoFrameRowLike {
  return {
    seq,
    ts: at(0),
    kind,
    hash: `sha256:${String(seq).padStart(64, "0")}`,
    contentDigest: "",
    bytesRef: "",
    redactions: "",
    toolName: "",
    toolStatus: "",
    toolUseId: "",
    model: "",
    provider: "",
    policyDecision: "",
    costUsdMicros: null,
    turnSeq: null,
    ...over,
  };
}

/** A wrapped frame on the run's own chain. */
const w = (seq: number, kind: string, over: Partial<TachoFrameRowLike> = {}) =>
  tachoFrame(row(seq, kind, over));

/** A wrapped frame on a subagent's chain. */
const s = (
  session: string,
  seq: number,
  kind: string,
  over: Partial<TachoFrameRowLike> = {},
  parent = ROOT,
) =>
  tachoFrame(
    row(seq, kind, {
      sessionUuid: session,
      rootSessionUuid: ROOT,
      parentSessionUuid: parent,
      subagentId: `agent-${session.slice(-2)}`,
      subagentType: "Explore",
      spawnToolUseId: `toolu_task_${session.slice(-2)}`,
      ...over,
    }),
  );

/** Columns of a body the recorder kept, under `digest`. */
const kept = (digest: string) => ({
  contentDigest: `sha256:${digest}`,
  bytesRef: `blob/${digest}`,
});
/** Columns of a body recorded only as its digest. */
const digestOnly = (digest: string) => ({
  contentDigest: `sha256:${digest}`,
  bytesRef: "",
});

function event(
  runSeq: number,
  eventType: string,
  payload: Record<string, unknown> | null,
): AttemptEventReadRecord {
  return {
    eventId: `e${runSeq}`,
    attemptId: "a1",
    attemptPublicId: "arat_1",
    runSeq: String(runSeq),
    attemptSeq: runSeq,
    eventSchemaVersion: "1",
    eventType,
    stage: "act",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    eventDigest: `sha256:${String(runSeq).padStart(64, "0")}`,
    payload,
    encryptedPayloadRef: payload === null ? "evb_x" : null,
    observedAt: new Date(
      `2026-09-11T10:00:${String(runSeq).padStart(2, "0")}.000Z`,
    ),
    recordedAt: new Date("2026-09-11T10:01:00.000Z"),
    body: NO_BODY,
  };
}

const ledger = (
  seq: number,
  type: string,
  payload: Record<string, unknown> | null = {},
) => ledgerFrame(event(seq, type, payload));

/** Each entry as its key and the keys of the frames it holds. */
const shape = (folds: readonly TranscriptFold[]) =>
  folds.map((fold) => [fold.key, fold.members.map(frameKey)]);

/** The entry at `n`, or a failing test. */
function nth(folds: readonly TranscriptFold[], n: number): TranscriptFold {
  const found = folds[n];
  if (found === undefined) throw new Error(`no entry ${String(n)}`);
  return found;
}

/** The entry that holds a frame with `key`, or a failing test. */
function holding(folds: readonly TranscriptFold[], key: string) {
  const found = folds.find((fold) =>
    fold.members.some((f) => f.identity.callId === key),
  );
  if (found === undefined) throw new Error(`no entry holds ${key}`);
  return found;
}

describe("the everything zoom", () => {
  const frames = [
    w(0, "agent_start"),
    w(1, "turn_start", { turnSeq: 1 }),
    w(2, "llm_call", { model: "m", costUsdMicros: 5, turnSeq: 1 }),
    w(3, "tool_call", { toolName: "Read", turnSeq: 1 }),
    w(4, "policy_decision", { policyDecision: "allow", turnSeq: 1 }),
    w(5, "turn_start", { turnSeq: 2 }),
    w(6, "llm_call", { model: "m", costUsdMicros: 7, turnSeq: 2 }),
    w(7, "agent_stop"),
  ];

  it("is one entry per frame, and says what kind each is", () => {
    const folded = foldTranscript(frames, "everything");
    expect(folded.map((f) => [f.key, f.kind, f.node])).toEqual([
      ["0", "frame", "control"],
      ["1", "frame", "prompt"],
      ["2", "model_call", "model"],
      ["3", "tool_call", "tool"],
      ["4", "policy", "policy"],
      ["5", "frame", "prompt"],
      ["6", "model_call", "model"],
      ["7", "frame", "seal"],
    ]);
    expect(folded.map((f) => f.turn)).toEqual([null, 1, 1, 1, 1, 2, 2, 2]);
  });

  it("leaves a frame that is no call half out of both slots, unless it is a boundary that kept its words", () => {
    const folded = foldTranscript(frames, "everything");
    for (const n of [0, 1, 4]) {
      expect([nth(folded, n).request, nth(folded, n).response]).toEqual([
        null,
        null,
      ]);
    }
    expect(nth(folded, 2).response?.seq).toBe("2");
    expect(nth(folded, 2).request).toBeNull();
    // A turn_start that kept the operator's words carries them as its request,
    // and a turn_end that kept the reply carries it as its response.
    const [prompt, reply] = frameFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("p") }),
      w(2, "turn_end", { turnSeq: 1, ...kept("r") }),
    ]);
    expect(prompt?.request?.seq).toBe("1");
    expect(reply?.response?.seq).toBe("2");
    expect(prompt?.quiet).toBe(false);
  });

  it("is empty for no frames at every zoom", () => {
    expect(foldTranscript([], "everything")).toEqual([]);
    expect(foldTranscript([], "steps")).toEqual([]);
    expect(foldTranscript([], "turns")).toEqual([]);
  });

  describe("an operator command", () => {
    const applied = (seq: number, command: string) =>
      w(seq, "oxagen:command_applied", {
        policyDecision: command === "resume" ? "allow" : "deny",
        attrs: { "command.id": `tcm_${seq}`, "command.name": command },
        body: JSON.stringify({
          policy_decision: command === "resume" ? "allow" : "deny",
          policy_source: "human",
          policy_reason_code: `${command}_applied`,
        }),
      });

    it("is its own policy entry, whose decision is the command, by the operator", () => {
      const [entry] = foldTranscript([applied(3, "pause")], "everything");
      expect(entry?.kind).toBe("policy");
      expect(entry?.node).toBe("policy");
      expect(entry?.quiet).toBe(false);
      expect(entry?.decision).toMatchObject({
        seq: "3",
        decision: "pause",
        type: "oxagen:command_applied",
        source: "human",
      });
    });

    it("records who decided a policy frame from its body", () => {
      const frame = w(1, "policy_decision", {
        policyDecision: "allow",
        body: JSON.stringify({
          policy_decision: "allow",
          policy_source: "harness",
        }),
      });
      expect(foldTranscript([frame], "everything")[0]?.decision?.source).toBe(
        "harness",
      );
    });

    it("says whether the decision is the harness checking itself, the one place that rule lives", () => {
      const decided = (seq: number, source: string | null) =>
        w(seq, "policy_decision", {
          policyDecision: "allow",
          body: JSON.stringify(
            source === null ? {} : { policy_source: source },
          ),
        });
      const entries = foldTranscript(
        [
          decided(1, "harness"),
          decided(2, "managed_settings"),
          decided(3, "bundle"),
          decided(4, "human"),
          decided(5, null),
        ],
        "everything",
      );
      expect(
        entries.map((e) => [e.decision?.source, e.decision?.harness]),
      ).toEqual([
        ["harness", true],
        ["managed_settings", true],
        ["bundle", false],
        ["human", false],
        [null, false],
      ]);
    });

    it("never becomes the decision of a call, and stays an entry of its own", () => {
      const folded = stepFolds([
        w(0, "tool_requested", { toolName: "Read", toolUseId: "toolu_r" }),
        applied(1, "steer"),
        w(2, "tool_call", {
          toolName: "Read",
          toolStatus: "ok",
          toolUseId: "toolu_r",
        }),
      ]);
      expect(shape(folded)).toEqual([
        ["0", ["0", "2"]],
        ["1", ["1"]],
      ]);
      expect(nth(folded, 0).decision).toBeNull();
      expect(nth(folded, 1).decision?.decision).toBe("steer");
    });
  });
});

describe("the steps zoom", () => {
  it("makes every event its own entry and never crosses a turn boundary", () => {
    // The fold this replaced folded every other frame into the step before
    // it, so each turn's prompt sat inside the previous turn's last call.
    const folded = stepFolds([
      w(0, "agent_start"),
      w(1, "turn_start", { turnSeq: 1, ...kept("p1") }),
      w(2, "llm_call", { model: "m", costUsdMicros: 5 }),
      w(3, "tool_call", { toolName: "Read", toolStatus: "ok" }),
      w(4, "turn_start", { turnSeq: 2, ...kept("p2") }),
      w(5, "llm_call", { model: "m", costUsdMicros: 7 }),
      w(6, "agent_stop"),
    ]);
    expect(
      folded.map((f) => [f.key, f.kind, f.node, f.turn, f.costMicros]),
    ).toEqual([
      ["0", "frame", "control", null, null],
      ["1", "frame", "prompt", 1, null],
      ["2", "model_call", "model", 1, 5],
      ["3", "tool_call", "tool", 1, null],
      ["4", "frame", "prompt", 2, null],
      ["5", "model_call", "model", 2, 7],
      ["6", "frame", "seal", 2, null],
    ]);
    expect(nth(folded, 4).request?.seq).toBe("4");
  });

  it("gathers a keyed gate recorded before its call into the call's step", () => {
    // hook-handler.ts seals `policy_decision` before `tool_requested`, with
    // the call's tool_use_id. The decision is about the call after it.
    const folded = stepFolds([
      w(0, "llm_call", { model: "m" }),
      w(1, "policy_decision", {
        policyDecision: "allow",
        toolName: "Read",
        toolUseId: "toolu_1",
      }),
      w(2, "tool_requested", { toolName: "Read", toolUseId: "toolu_1" }),
      w(3, "tool_call", {
        toolName: "Read",
        toolStatus: "ok",
        toolUseId: "toolu_1",
      }),
    ]);
    expect(shape(folded)).toEqual([
      ["0", ["0"]],
      ["1", ["1", "2", "3"]],
    ]);
    const call = nth(folded, 1);
    expect(nth(folded, 0).decision).toBeNull();
    expect(call.kind).toBe("tool_call");
    expect(call.decision?.decision).toBe("allow");
    expect(call.gates.map((g) => g.seq)).toEqual(["1"]);
    expect([call.request?.seq, call.response?.seq]).toEqual(["2", "3"]);
    expect(call.subject).toBe("Read");
  });

  it("keeps an unkeyed decision before an unkeyed request as its own entry (negative)", () => {
    // Nothing on the record ties the two together, so the fold claims no tie.
    const folded = stepFolds([
      w(0, "policy_decision", { policyDecision: "allow", toolName: "Read" }),
      w(1, "tool_requested", { toolName: "Read" }),
      w(2, "tool_call", { toolName: "Read", toolStatus: "ok" }),
    ]);
    expect(shape(folded)).toEqual([
      ["0", ["0"]],
      ["1", ["1", "2"]],
    ]);
    expect(nth(folded, 0)).toMatchObject({
      node: "policy",
      subject: "Read",
      quiet: false,
    });
  });

  it("filters after the fold, so a filtered read shows the same steps (finding 4052307523)", () => {
    const frames = [
      w(0, "llm_call", { model: "m" }),
      w(1, "policy_decision", { policyDecision: "allow", toolUseId: "t" }),
      w(2, "tool_requested", { toolName: "Read", toolUseId: "t" }),
      w(3, "tool_call", { toolName: "Read", toolStatus: "ok", toolUseId: "t" }),
    ];
    const all = stepFolds(frames);
    const filtered = filterFoldsByKind(all, ["policy", "tools"]);
    expect(shape(filtered)).toEqual([["1", ["1", "2", "3"]]]);
    expect(filtered[0]).toBe(all[1]);
    expect(filtered[0]?.decision?.decision).toBe("allow");
    expect(filterFoldsByKind(all, [])).toEqual(all);
    expect(filterFoldsByKind(all, ["recall"])).toEqual([]);
  });

  it("carries a keyed request whose model response never came as a pending one-frame step (negative)", () => {
    const folded = stepFolds([
      w(1, "model.request", { model: "m", toolUseId: "m1" }),
      w(2, "model.response", { model: "m", toolUseId: "m2" }),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1"]],
      ["2", ["2"]],
    ]);
    expect(nth(folded, 0)).toMatchObject({
      outcome: "pending",
      durationMs: null,
      model: "m",
    });
    expect(nth(folded, 1).outcome).toBe("ok");
  });
});

describe("pairing a model call's halves", () => {
  it("pairs a keyed request with its response by key, across another frame of the same call", () => {
    const folded = stepFolds([
      w(1, "model.request", { model: "m", toolUseId: "m1", ts: at(1) }),
      w(2, "oxagen:stream_tick", { toolUseId: "m1" }),
      w(3, "model.response", { model: "m", toolUseId: "m1", ts: at(4) }),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1", "3"]],
      ["2", ["2"]],
    ]);
    expect(nth(folded, 0)).toMatchObject({
      kind: "model_call",
      span: { open: 0, end: 2 },
      durationMs: 3_000,
    });
  });

  it("pairs a keyed engine call with its receipt, not with a wrapped response of the same key", () => {
    const folded = stepFolds([
      ledger(1, "model.engine_call_started", { model_call_id: "m1" }),
      w(2, "model.response", { model: "m", toolUseId: "m1" }),
      ledger(3, "model.engine_call_completed", { model_call_id: "m1" }),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1", "3"]],
      ["2", ["2"]],
    ]);
  });

  it("does not pair an unkeyed request with a response that is not next to it (negative)", () => {
    const folded = stepFolds([
      w(1, "model.request", { model: "m" }),
      w(2, "oxagen:stream_tick"),
      w(3, "model.response", { model: "m" }),
    ]);
    expect(folded.map((f) => [f.key, f.kind])).toEqual([
      ["1", "model_call"],
      ["2", "frame"],
      ["3", "model_call"],
    ]);
  });

  it("pairs an unkeyed request with the response right after it", () => {
    const folded = stepFolds([
      w(1, "model.request", { model: "m" }),
      w(2, "model.response", { model: "m" }),
    ]);
    expect(shape(folded)).toEqual([["1", ["1", "2"]]]);
  });
});

/**
 * `frames`, each behind a proxy that counts every field read on it, and the
 * running count. The fold reads a frame's fields each time it compares that
 * frame, so the reads measure the work it did without a clock.
 */
function counted(frames: readonly RunFrame[]): {
  frames: RunFrame[];
  reads: () => number;
} {
  let reads = 0;
  const handler: ProxyHandler<RunFrame> = {
    get(target, field, receiver) {
      reads += 1;
      return Reflect.get(target, field, receiver) as unknown;
    },
  };
  return {
    frames: frames.map((frame) => new Proxy(frame, handler)),
    reads: () => reads,
  };
}

// Finding P3-8 of the ADR-182 review: rule 2 rescanned a key's every frame
// for each request, so a key sealed many times folded in quadratic time. A
// read holds up to 10,000 frames (TRANSCRIPT_FRAME_CAP).
describe("a key sealed on every frame of a full read", () => {
  it("pairs each request with the next response no other request took, in linear time", () => {
    const half = 5_000;
    const { frames, reads } = counted([
      ...Array.from({ length: half }, (_, i) =>
        w(i, "model.request", { model: "m", toolUseId: "m1" }),
      ),
      ...Array.from({ length: half }, (_, i) =>
        w(half + i, "model.response", { model: "m", toolUseId: "m1" }),
      ),
    ]);
    const folded = stepFolds(frames);
    expect(folded).toHaveLength(half);
    expect(
      folded.every(
        (fold, i) =>
          fold.members.length === 2 &&
          fold.members[1]?.seq === String(half + i),
      ),
    ).toBe(true);
    // Work, not time, so a slow or instrumented runner cannot fail it (P3-6
    // of the re-review). A scan of the key's frames for each request reads
    // at least half × half = 25,000,000 fields. The linear fold reads a
    // bounded number per frame: 42 when this was written.
    expect(reads()).toBeLessThan(frames.length * 100);
  });
});

describe("a call key sealed twice (#3994)", () => {
  // The reproduction from #3994: two requests and two results on one key. A
  // PreToolUse hook delivered twice writes the request twice (tacho
  // claude-code/hooks.ts writes one `tool_requested` per delivery).
  it("draws the recorded tool call as one step holding each frame once", () => {
    const folded = stepFolds([
      w(0, "tool_requested", { toolName: "Bash", toolUseId: "K" }),
      w(1, "tool_requested", { toolName: "Bash", toolUseId: "K" }),
      w(2, "tool_call", { toolName: "Bash", toolStatus: "ok", toolUseId: "K" }),
      w(3, "tool_call", { toolName: "Bash", toolStatus: "ok", toolUseId: "K" }),
    ]);
    expect(shape(folded)).toEqual([["0", ["0", "1", "2", "3"]]]);
    expect(nth(folded, 0)).toMatchObject({ outcome: "ok", frames: 4 });
  });

  it("pairs each model request with the next response no other request took", () => {
    const folded = stepFolds([
      w(0, "model.request", { model: "m", toolUseId: "K" }),
      w(1, "model.request", { model: "m", toolUseId: "K" }),
      w(2, "model.response", { model: "m", toolUseId: "K" }),
      w(3, "model.response", { model: "m", toolUseId: "K" }),
    ]);
    expect(shape(folded)).toEqual([
      ["0", ["0", "2"]],
      ["1", ["1", "3"]],
    ]);
    const seen = folded.flatMap((f) => f.members.map(frameKey));
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("pairing a tool call's halves", () => {
  it("leaves a keyed request whose call never came as a pending one-frame step", () => {
    const folded = stepFolds([
      w(1, "tool_requested", { toolName: "Read", toolUseId: "t1" }),
    ]);
    expect(shape(folded)).toEqual([["1", ["1"]]]);
    expect(nth(folded, 0)).toMatchObject({
      node: "tool",
      subject: "Read",
      family: "read",
      outcome: "pending",
      durationMs: null,
    });
  });

  it("ends an unkeyed request at the first frame that is neither a gate nor its call (negative)", () => {
    const folded = stepFolds([
      w(1, "tool_requested", { toolName: "Bash" }),
      w(2, "policy_decision", { policyDecision: "allow", toolName: "Bash" }),
      w(3, "llm_call", { model: "m" }),
      w(4, "tool_call", { toolName: "Bash", toolStatus: "ok" }),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1", "2"]],
      ["3", ["3"]],
      ["4", ["4"]],
    ]);
    expect(nth(folded, 0).decision?.decision).toBe("allow");
  });

  it("closes an unkeyed request at its unkeyed receipt, with the gates between", () => {
    const folded = stepFolds([
      w(1, "tool_requested", { toolName: "Bash", ts: at(1) }),
      w(2, "policy_decision", { policyDecision: "allow", ts: at(2) }),
      w(3, "tool_call", { toolName: "Bash", toolStatus: "ok", ts: at(5) }),
    ]);
    expect(shape(folded)).toEqual([["1", ["1", "2", "3"]]]);
    expect(nth(folded, 0)).toMatchObject({ outcome: "ok", durationMs: 4_000 });
  });

  it("does not fold a keyed effect frame into a call that recorded no key (negative)", () => {
    const folded = stepFolds([
      w(1, "tool_call", { toolName: "Bash", toolStatus: "ok" }),
      w(2, "command", { toolUseId: "toolu_x" }),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1"]],
      ["2", ["2"]],
    ]);
  });
});

describe("the engine's own call halves", () => {
  const started = (seq: number, id: string, tool: string) =>
    ledger(seq, "tool.engine_call_started", {
      tool_call_id: id,
      tool_name: tool,
      input_digest: `sha256:${"b".repeat(64)}`,
    });
  const completed = (seq: number, id: string, tool: string) =>
    ledger(seq, "tool.engine_call_completed", {
      tool_call_id: id,
      tool_name: tool,
      outcome: "completed",
      input_digest: `sha256:${"b".repeat(64)}`,
      duration_ms: 1,
    });

  it("folds an engine tool exchange into ONE step carrying both halves", () => {
    const folded = stepFolds([
      started(1, "tc_1", "read_file"),
      completed(2, "tc_1", "read_file"),
    ]);
    expect(folded).toHaveLength(1);
    expect(nth(folded, 0)).toMatchObject({
      kind: "tool_call",
      subject: "read_file",
      family: "read",
      outcome: "ok",
    });
    expect(nth(folded, 0).request?.seq).toBe("1");
    expect(nth(folded, 0).response?.seq).toBe("2");
  });

  it("does not pair two halves of different calls", () => {
    const folded = stepFolds([
      started(1, "tc_1", "a"),
      completed(2, "tc_2", "b"),
    ]);
    expect(folded).toHaveLength(2);
    expect(nth(folded, 0).response).toBeNull();
    expect(nth(folded, 1).request).toBeNull();
  });

  it("matches an overlapping call's completion to its own request (finding 5, negative)", () => {
    // start A, start B, complete A, complete B: parallel tool calls are the
    // ordinary case, not the exotic one.
    const folded = stepFolds([
      started(1, "tc_a", "a"),
      started(2, "tc_b", "b"),
      completed(3, "tc_a", "a"),
      completed(4, "tc_b", "b"),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1", "3"]],
      ["2", ["2", "4"]],
    ]);
  });

  it("pairs overlapping wrapped tool calls on toolUseId the same way (negative)", () => {
    const folded = stepFolds([
      w(1, "tool_requested", { toolName: "a", toolUseId: "tu_a" }),
      w(2, "tool_requested", { toolName: "b", toolUseId: "tu_b" }),
      w(3, "tool_call", { toolName: "a", toolUseId: "tu_a", toolStatus: "ok" }),
      w(4, "tool_call", { toolName: "b", toolUseId: "tu_b", toolStatus: "ok" }),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1", "3"]],
      ["2", ["2", "4"]],
    ]);
  });

  describe("on a run the in-app assistant recorded", () => {
    const assistant = [
      ledger(1, "admission.run_admitted", {
        engine_name: "stella",
        engine_version: "1",
      }),
      ledger(2, "model.engine_call_started", {
        model_call_id: "prov-1-0",
        provider: "anthropic",
        model: "haiku",
      }),
      ledger(3, "model.engine_call_completed", {
        model_call_id: "prov-1-0",
        provider: "anthropic",
        model: "haiku",
        turn_index: 0,
      }),
      started(4, "tool-1-0", "read_file"),
      completed(5, "tool-1-0", "read_file"),
    ];

    it("opens a step at its intention and closes it at the completion", () => {
      expect(
        stepFolds(assistant).map((f) => [f.key, f.endSeq, f.kind, f.frames]),
      ).toEqual([
        ["1", "1", "frame", 1],
        ["2", "3", "model_call", 2],
        ["4", "5", "tool_call", 2],
      ]);
    });

    it("puts each call's request on the same entry as its result", () => {
      const [admitted, model, tool] = stepFolds(assistant);
      expect(admitted?.node).toBe("control");
      expect(admitted?.quiet).toBe(true);
      expect([model?.request?.seq, model?.response?.seq]).toEqual(["2", "3"]);
      expect(model?.model).toBe("anthropic/haiku");
      expect(model?.durationMs).toBe(1_000);
      expect([tool?.request?.seq, tool?.response?.seq]).toEqual(["4", "5"]);
    });

    it("names the step kind of both halves of each call", () => {
      expect(assistant.map((f) => stepKind(f))).toEqual([
        null,
        "model_call",
        "model_call",
        "tool_call",
        "tool_call",
      ]);
    });
  });
});

describe("effect frames fold into the call they belong to", () => {
  it("folds a call's effect frame into its step", () => {
    const folded = stepFolds([
      w(1, "tool_call", { toolName: "Bash", toolStatus: "ok", toolUseId: "a" }),
      w(2, "command", { toolUseId: "a" }),
    ]);
    expect(shape(folded)).toEqual([["1", ["1", "2"]]]);
  });

  it("folds a request, its call and every effect frame the call wrote", () => {
    const folded = stepFolds([
      w(1, "tool_requested", { toolName: "Bash", toolUseId: "a" }),
      w(2, "tool_call", { toolName: "Bash", toolStatus: "ok", toolUseId: "a" }),
      w(3, "command", { toolUseId: "a" }),
      w(4, "file_io", { toolUseId: "a" }),
    ]);
    expect(shape(folded)).toEqual([["1", ["1", "2", "3", "4"]]]);
  });

  it("leaves an effect frame that names a different call as its own step", () => {
    const folded = stepFolds([
      w(1, "tool_call", { toolName: "Bash", toolStatus: "ok", toolUseId: "a" }),
      w(2, "command", { toolUseId: "b" }),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1"]],
      ["2", ["2"]],
    ]);
    expect(nth(folded, 1)).toMatchObject({ node: "event", quiet: true });
  });

  it("falls back to adjacency only when neither side recorded a key", () => {
    const folded = stepFolds([
      w(1, "tool_call", { toolName: "Bash", toolStatus: "ok" }),
      w(2, "command"),
    ]);
    expect(shape(folded)).toEqual([["1", ["1", "2"]]]);
  });

  it("stops at the next call rather than swallow it", () => {
    const folded = stepFolds([
      w(1, "tool_call", { toolName: "Bash", toolStatus: "ok", toolUseId: "a" }),
      w(2, "command", { toolUseId: "a" }),
      w(3, "tool_call", { toolName: "Read", toolStatus: "ok", toolUseId: "b" }),
    ]);
    expect(shape(folded)).toEqual([
      ["1", ["1", "2"]],
      ["3", ["3"]],
    ]);
  });
});

describe("repeated bookkeeping frames", () => {
  it("folds a run of the same frame with nothing on it into one quiet step", () => {
    // Claude Code registers its hooks one frame at a time at a session's
    // start; thirty identical rows before the prompt is what the page drew.
    const folded = stepFolds([
      w(0, "agent_start"),
      w(1, "oxagen:hook_health"),
      w(2, "oxagen:hook_health"),
      w(3, "oxagen:hook_health"),
      w(4, "oxagen:mcp_connection"),
      w(5, "oxagen:mcp_connection"),
      w(6, "llm_call", { model: "m" }),
      w(7, "oxagen:hook_health"),
    ]);
    expect(folded.map((f) => [f.key, f.span.open, f.span.end])).toEqual([
      ["0", 0, 0],
      ["1", 1, 3],
      ["4", 4, 5],
      ["6", 6, 6],
      ["7", 7, 7],
    ]);
    expect(nth(folded, 1)).toMatchObject({
      frames: 3,
      node: "control",
      quiet: true,
    });
  });

  it("does not fold a frame that kept a boundary body or records a decision (negative)", () => {
    const folded = stepFolds([
      w(0, "turn_end", { turnSeq: 1 }),
      w(1, "turn_end", { turnSeq: 1, ...kept("r") }),
      w(2, "turn_end", { turnSeq: 1 }),
      w(3, "policy_decision", { policyDecision: "allow" }),
      w(4, "policy_decision", { policyDecision: "allow" }),
    ]);
    expect(folded.map((f) => f.key)).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("does not fold a subagent's frame into the run's own (negative)", () => {
    const folded = stepFolds([
      w(0, "oxagen:hook_health"),
      s(SUB, 0, "oxagen:hook_health"),
    ]);
    expect(folded.map((f) => f.key)).toEqual(["0", `${SUB}:0`]);
  });
});

describe("a tool call sealed by three sources", () => {
  const call = "toolu_01dupe";
  const copy = (seq: number, digest: string) =>
    w(seq, "tool_call", {
      toolName: "Read",
      toolStatus: "ok",
      toolUseId: call,
      ...digestOnly(digest),
    });
  const frames = [
    w(0, "tool_requested", { toolName: "Read", toolUseId: call, ...kept("q") }),
    copy(1, "c1"),
    w(2, "llm_call", { model: "m" }),
    w(3, "tool_call", {
      toolName: "Read",
      toolStatus: "ok",
      toolUseId: call,
      ...kept("b"),
    }),
    copy(4, "c2"),
  ];

  it("folds the hook, OTel and transcript copies into one step on the call id", () => {
    expect(shape(stepFolds(frames))).toEqual([
      ["0", ["0", "1", "3", "4"]],
      ["2", ["2"]],
    ]);
  });

  it("takes the copy that kept its body as the result, passing over the digest-only ones", () => {
    const step = nth(stepFolds(frames), 0);
    expect(step.response?.seq).toBe("3");
    expect(step.request?.seq).toBe("0");
    // Every copy digest-only: the first copy stands for the result, and the
    // step still names its tool (negative).
    const bare = nth(stepFolds([copy(0, "a"), copy(1, "b")]), 0);
    expect(bare.response?.seq).toBe("0");
    expect(bare.subject).toBe("Read");
  });

  it("does not fold a call with no call id, or a different one (negative)", () => {
    const other = w(3, "tool_call", {
      toolName: "Read",
      toolStatus: "ok",
      toolUseId: "toolu_other",
    });
    const none = w(4, "tool_call", { toolName: "Read", toolStatus: "ok" });
    const [requested, called] = frames;
    if (requested === undefined || called === undefined)
      throw new Error("expected the request and the call");
    expect(
      stepFolds([requested, called, other, none]).map((f) => f.key),
    ).toEqual(["0", "3", "4"]);
  });
});

describe("a wrapped Claude Code session", () => {
  const gate = (seq: number, key: string, tool = "Bash") =>
    w(seq, "policy_decision", {
      policyDecision: "allow",
      toolName: tool,
      toolUseId: key,
    });
  const harness = (seq: number, key: string, verdict = "allow") =>
    w(seq, "harness_permission", {
      policyDecision: verdict,
      toolName: "Bash",
      toolUseId: key,
    });
  const call = (seq: number, key: string, tool = "Bash") =>
    w(seq, "tool_call", { toolName: tool, toolStatus: "ok", toolUseId: key });
  const spawn = "toolu_task_c1";
  const sub = (seq: number, kind: string, over: Partial<TachoFrameRowLike>) =>
    s(SUB, seq, kind, over);
  const frames = [
    w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
    gate(2, "toolu_A"),
    gate(3, "toolu_B"),
    harness(4, "toolu_A"),
    harness(5, "toolu_B"),
    call(6, "toolu_A"),
    call(7, "toolu_B"),
    gate(8, spawn, "Task"),
    harness(9, spawn),
    w(10, "subagent_start", { toolUseId: spawn }),
    sub(0, "policy_decision", {
      policyDecision: "allow",
      toolName: "Grep",
      toolUseId: "toolu_X1",
    }),
    sub(1, "tool_call", {
      toolName: "Grep",
      toolStatus: "ok",
      toolUseId: "toolu_X1",
    }),
    sub(2, "policy_decision", {
      policyDecision: "allow",
      toolName: "Read",
      toolUseId: "toolu_X2",
    }),
    sub(3, "tool_call", {
      toolName: "Read",
      toolStatus: "ok",
      toolUseId: "toolu_X2",
    }),
    call(11, spawn, "Task"),
    harness(12, "toolu_D", "deny"),
    harness(13, "toolu_E"),
  ];
  const steps = stepFolds(frames);

  it("draws one step per call, not one row per permission check", () => {
    const calls = steps.filter((f) => f.node === "tool");
    expect(calls.map((f) => f.subject)).toEqual([
      "Bash",
      "Bash",
      "Task",
      "Grep",
      "Read",
    ]);
    expect(holding(steps, "toolu_A").members.map(frameKey)).toEqual([
      "2",
      "4",
      "6",
    ]);
    expect(holding(steps, "toolu_B").members.map(frameKey)).toEqual([
      "3",
      "5",
      "7",
    ]);
  });

  it("lists Oxagen's gate on the call and no gate for the harness's own check", () => {
    const b = holding(steps, "toolu_B");
    expect(b.gates.map((g) => [g.type, g.seq])).toEqual([
      ["policy_decision", "3"],
    ]);
    expect(b.outcome).toBe("ok");
    expect(b.durationMs).toBe(0);
  });

  it("names the Task call as the parent of the subagent's calls", () => {
    const task = holding(steps, spawn);
    expect(task.members.map((f) => f.type)).toContain("subagent_start");
    expect(task.family).toBe("agent");
    const nested = steps.filter((f) => f.parentKey === task.key);
    expect(nested.map((f) => f.subject)).toEqual(["Grep", "Read"]);
    expect(steps.filter((f) => f.parentKey !== null)).toEqual(nested);
  });

  it("reads a harness refusal as a refused call, and a harness allow on nothing as quiet", () => {
    const refused = holding(steps, "toolu_D");
    expect(refused).toMatchObject({
      node: "event",
      outcome: "denied",
      subject: "Bash",
      quiet: false,
    });
    expect(holding(steps, "toolu_E")).toMatchObject({
      outcome: null,
      quiet: true,
    });
  });
});

describe("how a call ended", () => {
  it("reads a parked receipt as parked, with the approval it names, and not as failed", () => {
    const [step] = stepFolds([
      ledger(1, "tool.engine_call_started", {
        tool_call_id: "tc_1",
        tool_name: "create_workspace",
      }),
      ledger(2, "tool.engine_call_completed", {
        tool_call_id: "tc_1",
        tool_name: "create_workspace",
        outcome: "parked",
        approval_public_id: "apr_0a1b2c3d4e5f6g7h8j9k0m",
      }),
    ]);
    expect(step).toMatchObject({
      outcome: "parked",
      approvalId: "apr_0a1b2c3d4e5f6g7h8j9k0m",
    });
  });

  it("reads a denied receipt as a refusal that parks nothing (negative)", () => {
    const [step] = stepFolds([
      ledger(2, "tool.engine_call_completed", {
        tool_call_id: "tc_1",
        tool_name: "create_workspace",
        outcome: "denied",
        approval_public_id: "apr_0a1b2c3d4e5f6g7h8j9k0m",
      }),
    ]);
    expect(step).toMatchObject({ outcome: "denied", approvalId: null });
  });

  it("reads a gate's deny as a refusal and an error status as a failure", () => {
    const [denied] = stepFolds([
      w(1, "policy_decision", { policyDecision: "deny", toolUseId: "t" }),
      w(2, "tool_requested", { toolName: "Bash", toolUseId: "t" }),
    ]);
    expect(denied?.outcome).toBe("denied");
    const [failed] = stepFolds([
      w(1, "tool_call", { toolName: "Bash", toolStatus: "error" }),
    ]);
    expect(failed?.outcome).toBe("failed");
  });

  it("parks a call on an approval nobody answered, and reads it answered once someone did", () => {
    const asked = [
      w(1, "tool_requested", { toolName: "Write", toolUseId: "t" }),
      w(2, "approval_request", { policyDecision: "ask", toolUseId: "t" }),
    ];
    expect(stepFolds(asked)[0]).toMatchObject({
      outcome: "parked",
      durationMs: null,
    });
    const answered = [
      ...asked,
      w(3, "approval_decision", { policyDecision: "allow", toolUseId: "t" }),
    ];
    expect(stepFolds(answered)[0]?.outcome).toBe("pending");
    const done = [
      ...answered,
      w(4, "tool_call", {
        toolName: "Write",
        toolStatus: "ok",
        toolUseId: "t",
      }),
    ];
    expect(stepFolds(done)[0]?.outcome).toBe("ok");
  });

  it("reads a model call that recorded an error as failed", () => {
    const [step] = stepFolds([w(1, "llm_call", { model: "m" })]);
    expect(step?.outcome).toBe("ok");
    const errored = {
      ...w(2, "llm_call", { model: "m" }),
      type: "model.error",
    };
    expect(frameFolds([errored])[0]).toMatchObject({
      node: "event",
      outcome: "failed",
      quiet: false,
    });
  });

  it("states no outcome at everything for a call's request frame, which cannot say how the call ended", () => {
    const frames = [
      w(1, "tool_requested", { toolName: "Bash", toolUseId: "k1" }),
      w(2, "tool_call", {
        toolName: "Bash",
        toolStatus: "ok",
        toolUseId: "k1",
      }),
      w(3, "model.request", { model: "m", toolUseId: "c1" }),
      w(4, "model.response", { model: "m", toolUseId: "c1" }),
    ];
    expect(
      frameFolds(frames).map((f) => [f.key, f.node, f.outcome, f.durationMs]),
    ).toEqual([
      ["1", "tool", null, null],
      ["2", "tool", "ok", null],
      ["3", "model", null, null],
      ["4", "model", "ok", null],
    ]);
  });

  it("keeps a lone request pending at steps, where the step is the whole call (negative)", () => {
    const [tool] = stepFolds([
      w(1, "tool_requested", { toolName: "Bash", toolUseId: "k1" }),
    ]);
    expect(tool?.outcome).toBe("pending");
  });
});

describe("turn boundaries and replies", () => {
  it("reads the operator's prompt as a prompt, and a subagent's as control", () => {
    const folded = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("p") }),
      s(SUB, 0, "turn_start", kept("brief")),
      s(SUB, 1, "turn_end", kept("found")),
    ]);
    expect(folded.map((f) => [f.key, f.node, f.quiet])).toEqual([
      ["1", "prompt", false],
      [`${SUB}:0`, "control", true],
      [`${SUB}:1`, "reply", false],
    ]);
  });

  it("reads a prompt or reply that kept no body as quiet", () => {
    const folded = stepFolds([
      w(1, "turn_start", { turnSeq: 1 }),
      w(2, "turn_end", { turnSeq: 1 }),
    ]);
    expect(folded.map((f) => [f.node, f.quiet])).toEqual([
      ["prompt", true],
      ["reply", true],
    ]);
  });

  it("reads a message the harness reported apart from the turn's end as the reply", () => {
    const message = w(3, "oxagen:message", {
      ...kept("r"),
      body: JSON.stringify({ last_assistant_message_digest: "sha256:r" }),
    });
    const [entry] = stepFolds([message]);
    expect(entry).toMatchObject({ node: "reply", quiet: false });
    expect(entry?.response?.seq).toBe("3");
  });

  it("leaves the echo unsettled until the words are read: the fold compares no digests", () => {
    const folded = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
      w(2, "turn_end", { turnSeq: 1, ...kept("prompt") }),
    ]);
    expect(folded.map((f) => [f.echoOf, f.quiet])).toEqual([
      [null, false],
      [null, false],
    ]);
  });

  it("reads the run's stop as its seal, and a subagent's stop as control (negative)", () => {
    const folded = stepFolds([
      s(SUB, 2, "agent_stop"),
      w(8, "agent_stop"),
      ledger(9, "terminal.attempt_terminated"),
    ]);
    expect(folded.map((f) => [f.node, f.quiet])).toEqual([
      ["control", true],
      ["seal", false],
      ["seal", false],
    ]);
  });

  it("reads what was recalled as recall", () => {
    const folded = stepFolds([
      ledger(1, "context.frames_selected", { frame_count: 6 }),
      w(2, "steering.manifest"),
    ]);
    expect(folded.map((f) => [f.node, f.quiet])).toEqual([
      ["recall", false],
      ["recall", false],
    ]);
  });
});

describe("the turns zoom", () => {
  const frames = [
    w(0, "agent_start"),
    w(1, "turn_start", { turnSeq: 1 }),
    w(2, "llm_call", { model: "m", costUsdMicros: 5, turnSeq: 1 }),
    w(3, "tool_call", { toolName: "Read", turnSeq: 1 }),
    w(4, "policy_decision", { policyDecision: "allow", turnSeq: 1 }),
    w(5, "turn_start", { turnSeq: 2 }),
    w(6, "llm_call", { model: "m", costUsdMicros: 7, turnSeq: 2 }),
    w(7, "agent_stop"),
  ];

  it("opens at turn_start and sums the turn's cost records", () => {
    const folded = foldTranscript(frames, "turns");
    expect(
      folded.map((f) => [f.key, f.endSeq, f.frames, f.costMicros, f.kind]),
    ).toEqual([
      ["0", "0", 1, null, "turn"],
      ["1", "4", 4, 5, "turn"],
      ["5", "7", 3, 7, "turn"],
    ]);
    expect(folded.map((f) => f.node)).toEqual([null, null, null]);
  });

  it("groups the steps zoom, so the two zooms agree on what a turn holds", () => {
    const steps = stepFolds(frames);
    const turns = turnFolds(frames, steps);
    for (const turn of turns) {
      const held = steps.filter((step) => step.turn === turn.turn);
      expect(turn.members.map(frameKey)).toEqual(
        held.flatMap((step) => step.members.map(frameKey)),
      );
    }
  });

  it("takes the model's reply as the turn's response when the prompt kept no body", () => {
    const turn = nth(foldTranscript(frames, "turns"), 1);
    expect(turn.request).toBeNull();
    expect(turn.response?.seq).toBe("2");
    expect(turn.decision?.decision).toBe("allow");
  });

  it("takes the operator's prompt as the request and the last reply of its own chain as the response", () => {
    const [turn] = foldTranscript(
      [
        w(1, "turn_start", { turnSeq: 1, ...kept("p"), ts: at(1) }),
        w(2, "llm_call", { model: "m", turnSeq: 1 }),
        s(SUB, 0, "turn_end", { ...kept("sub"), ts: at(5) }),
        w(3, "turn_end", { turnSeq: 1, ...kept("r"), ts: at(9) }),
        s(SUB, 1, "turn_end", { ...kept("late"), ts: at(10) }),
      ],
      "turns",
    );
    expect(turn?.request?.seq).toBe("1");
    // A subagent's words are its own, not the turn's reply.
    expect(turn?.response?.seq).toBe("3");
    // First frame to last, the subagent's late words included.
    expect(turn?.durationMs).toBe(9_000);
  });

  it("answers to the chips of every frame it folds, not only its halves (#3370)", () => {
    const [turn] = foldTranscript(
      [
        w(0, "turn_start", { turnSeq: 1 }),
        w(1, "llm_call", { model: "m", turnSeq: 1, ...kept("m") }),
        w(2, "tool_call", {
          toolName: "Read",
          toolStatus: "failed",
          turnSeq: 1,
        }),
      ],
      "turns",
    );
    expect(turn?.response?.seq).toBe("1");
    expect([...(turn?.kinds ?? [])].sort()).toEqual([
      "errors",
      "prompt",
      "responses",
      "tools",
    ]);
  });

  it("follows the turn index when the recording has no boundaries, and is one turn when it has neither", () => {
    const run = [
      ledger(1, "admission.run_admitted", {
        engine_name: "stella",
        engine_version: "1",
      }),
      ledger(2, "model.call_completed", { turn_index: 0 }),
      ledger(3, "tool.call_completed", {
        capability_name: "read_file",
        outcome: "completed",
      }),
      ledger(4, "model.call_completed", { turn_index: 1 }),
    ];
    expect(foldTranscript(run, "turns").map((f) => [f.key, f.endSeq])).toEqual([
      ["1", "3"],
      ["4", "4"],
    ]);
    const oneTurn = run.map((f) => ({ ...f, turnIndex: null }));
    expect(foldTranscript(oneTurn, "turns")).toHaveLength(1);
  });
});

describe("a subagent's entries", () => {
  it("nest under the call that spawned their chain, by its key", () => {
    const folded = stepFolds([
      w(1, "tool_requested", { toolName: "Task", toolUseId: "toolu_task_c1" }),
      w(2, "subagent_start", { toolUseId: "toolu_task_c1" }),
      s(SUB, 0, "llm_call", { model: "m" }),
      s(SUB, 1, "subagent_start", { toolUseId: "toolu_task_c3" }),
      s(NESTED, 0, "llm_call", { model: "m" }, SUB),
      w(3, "tool_call", {
        toolName: "Task",
        toolStatus: "ok",
        toolUseId: "toolu_task_c1",
      }),
    ]);
    expect(folded.map((f) => [f.key, f.parentKey])).toEqual([
      ["1", null],
      [`${SUB}:0`, "1"],
      [`${SUB}:1`, "1"],
      // A subagent's own subagent nests under the step that spawned it.
      [`${NESTED}:0`, `${SUB}:1`],
    ]);
  });

  it("nest under the latest spawn on their parent chain when no call key was recorded", () => {
    const folded = stepFolds([
      w(1, "subagent_start"),
      s(SUB, 0, "llm_call", { model: "m", spawnToolUseId: "" }),
      w(2, "llm_call", { model: "m" }),
    ]);
    expect(folded.map((f) => f.parentKey)).toEqual([null, "1", null]);
  });

  it("stay unnested when nothing on the record names their spawn (negative)", () => {
    const folded = stepFolds([
      w(1, "llm_call", { model: "m" }),
      s(SUB, 0, "llm_call", { model: "m", spawnToolUseId: "" }),
    ]);
    expect(folded.map((f) => f.parentKey)).toEqual([null, null]);
  });

  it("nest at the everything zoom under the first frame of the spawning call", () => {
    const folded = frameFolds([
      w(1, "policy_decision", {
        policyDecision: "allow",
        toolUseId: "toolu_task_c1",
      }),
      w(2, "tool_requested", { toolName: "Task", toolUseId: "toolu_task_c1" }),
      s(SUB, 0, "llm_call", { model: "m" }),
    ]);
    expect(folded.map((f) => f.parentKey)).toEqual([null, null, "1"]);
  });
});

/**
 * A `markWords` reader that answers from a table of words by entry key, as
 * the digest of each entry's words (`wordsDigest`), the way the handler does.
 */
function reader(table: Record<string, string | null>) {
  const asked: string[][] = [];
  const read = (needed: readonly TranscriptFold[]) => {
    asked.push(needed.map((fold) => fold.key));
    return Promise.resolve(
      new Map(
        needed.flatMap((fold) =>
          fold.key in table
            ? [[fold, wordsDigest(table[fold.key] ?? null)] as const]
            : [],
        ),
      ),
    );
  };
  return { read, asked };
}

describe("wordsDigest", () => {
  it("names words by the digest of their trimmed text, so surrounding whitespace does not count", () => {
    expect(wordsDigest("  Fixed it.\n")).toBe(wordsDigest("Fixed it."));
    expect(wordsDigest("Fixed it.")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(wordsDigest("Fixed it.")).not.toBe(wordsDigest("Fixed it"));
  });

  it("gives no digest for blank text or none (negative)", () => {
    expect(wordsDigest(" \n\t")).toBeNull();
    expect(wordsDigest("")).toBeNull();
    expect(wordsDigest(null)).toBeNull();
  });
});

describe("markWords", () => {
  const facts = (folds: readonly TranscriptFold[]) =>
    folds.map((f) => [f.key, f.node, f.quiet, f.echoOf]);

  it("reads a turn's closing message that repeats the model's last words as an echo of that step", async () => {
    // The model's reply is kept as the stream it arrived in and the closing
    // message as plain words, so their digests differ; their words do not.
    const folds = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
      w(2, "llm_call", { turnSeq: 1, model: "m", ...kept("stream") }),
      w(3, "turn_end", { turnSeq: 1, ...kept("words") }),
    ]);
    const { read, asked } = reader({
      "1": "Fix the build.",
      "2": "Fixed it.\n",
      "3": "  Fixed it.",
    });
    await markWords(folds, read);
    expect(facts(folds)).toEqual([
      ["1", "prompt", false, null],
      ["2", "model", false, null],
      ["3", "reply", true, "2"],
    ]);
    // One read, for the prompt, the reply and the step said before the reply.
    expect(asked).toEqual([["1", "3", "2"]]);
  });

  it("reads a message that repeats the operator's prompt, and a reply that repeats the reply before it", async () => {
    const reply = (seq: number) =>
      w(seq, "turn_end", { turnSeq: 1, ...kept(`r${String(seq)}`) });
    const folds = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
      reply(2),
      reply(3),
      reply(4),
      reply(5),
    ]);
    const { read } = reader({
      "1": "Fix the build.",
      "2": "Fix the build.",
      "3": "Done.",
      "4": "Done.",
      "5": "Anything else?",
    });
    await markWords(folds, read);
    expect(folds.map((f) => f.echoOf)).toEqual([null, "1", null, "3", null]);
    expect(folds.map((f) => f.quiet)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it("keeps a subagent's words that repeat the operator's or the run's, and never echoes across turns (negative)", async () => {
    const folds = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
      w(2, "llm_call", { turnSeq: 1, model: "m", ...kept("stream") }),
      s(SUB, 0, "turn_end", kept("brief")),
      w(3, "turn_start", { turnSeq: 2, ...kept("prompt2") }),
      w(4, "turn_end", { turnSeq: 2, ...kept("late") }),
    ]);
    const { read } = reader({
      "1": "Look around.",
      "2": "Looked.",
      [`${SUB}:0`]: "Look around.",
      "3": "Again.",
      "4": "Looked.",
    });
    await markWords(folds, read);
    expect(folds.map((f) => [f.echoOf, f.quiet])).toEqual([
      [null, false],
      [null, false],
      [null, false],
      [null, false],
      [null, false],
    ]);
  });

  it("reads a prompt or reply with only whitespace, or no words to show, as having nothing to show", async () => {
    const folds = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("blank") }),
      w(2, "turn_end", { turnSeq: 1, ...kept("stream") }),
      w(3, "oxagen:message", {
        turnSeq: 1,
        ...kept("r"),
        body: JSON.stringify({ last_assistant_message_digest: "sha256:r" }),
      }),
    ]);
    const { read } = reader({ "1": " \n\t", "2": null, "3": "Released." });
    await markWords(folds, read);
    expect(facts(folds)).toEqual([
      ["1", "prompt", true, null],
      ["2", "reply", true, null],
      ["3", "reply", false, null],
    ]);
  });

  it("leaves an entry the read did not answer as the fold said, and reads nothing when nothing has words (negative)", async () => {
    const folds = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
      w(2, "turn_end", { turnSeq: 1, ...kept("reply") }),
    ]);
    await markWords(folds, reader({}).read);
    expect(folds.map((f) => [f.quiet, f.echoOf])).toEqual([
      [false, null],
      [false, null],
    ]);

    const silent = stepFolds([
      w(1, "turn_start", { turnSeq: 1 }),
      w(2, "llm_call", { turnSeq: 1, model: "m", ...kept("stream") }),
      w(3, "tool_call", { turnSeq: 1, toolName: "Bash", toolStatus: "ok" }),
    ]);
    const { read, asked } = reader({});
    await markWords(silent, read);
    expect(asked).toEqual([]);
  });

  it("names the half an entry says its words in", () => {
    const [prompt, model, reply] = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("p") }),
      w(2, "llm_call", { turnSeq: 1, model: "m", ...kept("m") }),
      w(3, "turn_end", { turnSeq: 1, ...kept("r") }),
    ]);
    expect(prompt && wordsHalf(prompt)?.seq).toBe("1");
    expect(model && wordsHalf(model)?.seq).toBe("2");
    expect(reply && wordsHalf(reply)?.seq).toBe("3");
  });
});

describe("transcriptCounts", () => {
  it("counts no entry a reader is shown nothing for: a quiet one, or a reply that repeats words just shown", async () => {
    const folds = stepFolds([
      w(0, "agent_start"),
      // A prompt that kept no body is quiet from the fold.
      w(1, "turn_start", { turnSeq: 1 }),
      w(2, "turn_start", { turnSeq: 2, ...kept("prompt") }),
      w(3, "llm_call", { turnSeq: 2, model: "m", ...kept("stream") }),
      w(4, "turn_end", { turnSeq: 2, ...kept("words") }),
    ]);
    await markWords(
      folds,
      reader({ "2": "Ship it.", "3": "Shipped.", "4": "Shipped." }).read,
    );
    const counts = transcriptCounts(folds, TRANSCRIPT_KINDS);
    expect(counts.entries).toBe(2);
    expect(counts.kinds).toMatchObject({ prompt: 1, responses: 1 });
  });

  it("counts every entry per chip, the entries with something to show, errors and decisions", () => {
    const folds = frameFolds([
      w(0, "agent_start"),
      w(1, "turn_start", { turnSeq: 1, ...kept("p") }),
      w(2, "llm_call", { model: "m", costUsdMicros: 3, ...kept("m") }),
      w(3, "tool_call", { toolName: "Bash", toolStatus: "error" }),
      w(4, "policy_decision", { policyDecision: "deny" }),
      w(5, "policy_decision", {
        policyDecision: "allow",
        body: JSON.stringify({ policy_source: "managed_settings" }),
      }),
      w(6, "harness_permission", { policyDecision: "deny", toolName: "Bash" }),
    ]);
    const counts = transcriptCounts(folds, TRANSCRIPT_KINDS);
    expect(counts.kinds).toMatchObject({
      prompt: 1,
      responses: 1,
      tools: 1,
      usage: 1,
      policy: 2,
      errors: 1,
      recall: 0,
    });
    expect(Object.keys(counts.kinds).sort()).toEqual(
      [...TRANSCRIPT_KINDS].sort(),
    );
    // Everything but the agent's start has something to show.
    expect(counts.entries).toBe(6);
    // The failed call, the denied gate and the harness refusal.
    expect(counts.errors).toBe(3);
    // The managed-settings check is the harness checking itself.
    expect(counts.policy).toBe(1);
  });

  // Finding P2 of the ADR-182 re-review: every model step counted, though a
  // call still waiting on its reply, and one kept as a digest with no cost
  // or tokens, draw no row. A model step counts where it draws: under
  // `responses` when its reply was kept, whatever the reply said, and under
  // `usage` when it carried a cost, tokens or an effort.
  it("counts a model step only under the chips it draws a row for, and not at all when it draws none (negative)", () => {
    const folds = stepFolds([
      w(0, "turn_start", { turnSeq: 1, ...kept("p") }),
      // A reply that only called a tool: kept, so a row under responses.
      w(1, "llm_call", { turnSeq: 1, model: "m", ...kept("tools-only") }),
      w(2, "tool_call", { turnSeq: 1, toolName: "Bash", toolUseId: "tu_b" }),
      // Kept as a digest, with a cost: a usage row and nothing else.
      w(3, "llm_call", {
        turnSeq: 1,
        model: "m",
        costUsdMicros: 5,
        ...digestOnly("priced"),
      }),
      // Kept as a digest, with the effort it ran at: a usage row.
      w(4, "llm_call", {
        turnSeq: 1,
        model: "m",
        effort: "high",
        ...digestOnly("effort"),
      }),
      // Kept as a digest with no figures: nothing to draw.
      w(5, "llm_call", { turnSeq: 1, model: "m", ...digestOnly("bare") }),
      // Sent and not yet answered: nothing to draw.
      w(6, "model.request", {
        turnSeq: 1,
        model: "m",
        toolUseId: "m_live",
        ...kept("request"),
      }),
    ]);
    const facts = folds.map((fold) => [
      fold.key,
      fold.node,
      fold.quiet,
      [...fold.kinds].sort(),
    ]);
    expect(facts).toEqual([
      ["0", "prompt", false, ["prompt"]],
      ["1", "model", false, ["responses"]],
      ["2", "tool", false, ["tools"]],
      ["3", "model", false, ["usage"]],
      ["4", "model", false, ["usage"]],
      ["5", "model", true, []],
      ["6", "model", true, []],
    ]);
    expect(folds[6]?.outcome).toBe("pending");
    const counts = transcriptCounts(folds, TRANSCRIPT_KINDS);
    expect(counts.entries).toBe(5);
    expect(counts.kinds).toMatchObject({
      prompt: 1,
      responses: 1,
      tools: 1,
      usage: 2,
    });
  });
});

describe("frameCounts", () => {
  const frames = [
    w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
    w(2, "steering.manifest", { turnSeq: 1 }),
    // The harness checking itself: the policy chip keeps it, the Policy
    // tab's count does not.
    w(3, "policy_decision", {
      turnSeq: 1,
      policyDecision: "deny",
      toolUseId: "t1",
      body: JSON.stringify({ policy_source: "managed_settings" }),
    }),
    // One call with two decisions: one step at `steps`, two frames.
    w(4, "policy_decision", {
      turnSeq: 1,
      policyDecision: "ask",
      toolUseId: "t2",
    }),
    w(5, "approval_decision", {
      turnSeq: 1,
      policyDecision: "approve",
      toolUseId: "t2",
    }),
    w(6, "tool_call", { turnSeq: 1, toolName: "Bash", toolUseId: "t2" }),
    w(7, "turn_end", { turnSeq: 1, ...kept("reply") }),
  ];

  it("counts the policy and recall frames as `transcriptCounts` does at everything", () => {
    const counts = frameCounts(frames);
    expect(counts).toEqual({ kinds: { policy: 3, recall: 1 }, policy: 2 });
    const everything = transcriptCounts(frameFolds(frames), TRANSCRIPT_KINDS);
    expect(counts).toEqual({
      kinds: {
        policy: everything.kinds.policy,
        recall: everything.kinds.recall,
      },
      policy: everything.policy,
    });
  });

  it("is not the count at steps, where one call's decisions are one entry (negative)", () => {
    const steps = transcriptCounts(stepFolds(frames), TRANSCRIPT_KINDS);
    expect(steps.kinds.policy).toBe(2);
    expect(frameCounts(frames).kinds.policy).toBe(3);
  });

  it("needs no words: marking the prompt and reply quiet changes no count it carries", async () => {
    const folds = frameFolds(frames);
    const before = transcriptCounts(folds, TRANSCRIPT_KINDS);
    await markWords(folds, reader({ "1": "  ", "7": "" }).read);
    const after = transcriptCounts(folds, TRANSCRIPT_KINDS);
    // The words did change what the entries count.
    expect(after.entries).toBe(before.entries - 2);
    expect(frameCounts(frames)).toEqual({
      kinds: { policy: after.kinds.policy, recall: after.kinds.recall },
      policy: after.policy,
    });
  });
});

describe("toolUseClaimer", () => {
  const frames = [
    w(1, "turn_start", { turnSeq: 1 }),
    w(2, "llm_call", { model: "m" }),
    w(3, "tool_call", { toolName: "Bash", toolStatus: "ok", toolUseId: "k1" }),
    w(4, "tool_call", { toolName: "claude_code__Read", toolStatus: "ok" }),
    w(5, "tool_call", { toolName: "Read", toolStatus: "ok" }),
    w(6, "turn_start", { turnSeq: 2 }),
    w(7, "tool_call", { toolName: "Grep", toolStatus: "ok" }),
  ];
  const steps = stepFolds(frames);
  const reply = frames[1] as RunFrame;

  it("claims a block by its call key, then by name for the next unclaimed step after the reply", () => {
    const claim = toolUseClaimer(steps);
    expect(
      claim(reply, [
        { name: "Bash", callKey: "k1" },
        { name: "Read", callKey: null },
        { name: "Read", callKey: null },
        { name: "Read", callKey: null },
      ]),
    ).toEqual(["3", "4", "5", null]);
  });

  it("claims nothing in another turn, or for a call no step recorded (negative)", () => {
    const claim = toolUseClaimer(steps);
    expect(
      claim(reply, [
        { name: "Grep", callKey: null },
        { name: "Edit", callKey: "k9" },
      ]),
    ).toEqual([null, null]);
  });

  it("does not claim a keyed step by name for a block that kept a different key (negative)", () => {
    const claim = toolUseClaimer(steps);
    expect(claim(reply, [{ name: "Bash", callKey: "k2" }])).toEqual([null]);
  });

  // Finding P3-2 of the ADR-182 review: claims were kept across the replies
  // one page asked about, so an unkeyed claim came out differently wherever
  // the page cut.
  describe("whatever the page holds", () => {
    const run = [
      w(1, "turn_start", { turnSeq: 1 }),
      w(2, "llm_call", { turnSeq: 1, model: "m" }),
      w(3, "llm_call", { turnSeq: 1, model: "m" }),
      w(4, "tool_call", { turnSeq: 1, toolName: "Bash", toolStatus: "ok" }),
      w(5, "llm_call", { turnSeq: 1, model: "m" }),
      w(6, "tool_call", { turnSeq: 1, toolName: "Bash", toolStatus: "ok" }),
    ];
    const folded = stepFolds(run);
    const [, first, second, , third] = run as RunFrame[];
    const bash = [{ name: "Bash", callKey: null }];

    it("claims the same steps for a reply asked alone or after the replies before it", () => {
      const all = toolUseClaimer(folded);
      const inOrder = [first, second, third].map((frame) =>
        all(frame as RunFrame, bash),
      );
      const alone = [third, second, first].map((frame) =>
        toolUseClaimer(folded)(frame as RunFrame, bash),
      );
      expect(inOrder).toEqual([[null], ["4"], ["6"]]);
      expect(alone.reverse()).toEqual(inOrder);
    });

    it("never claims past the chain's next model call, which the reply's calls ran before (negative)", () => {
      // The first reply's Bash ran before the second model call, or it ran
      // nowhere the record shows.
      expect(toolUseClaimer(folded)(first as RunFrame, bash)).toEqual([null]);
    });
  });

  it("claims from the step a carrying frame belongs to, so a turn's reply claims as its model step does", () => {
    const run = [
      w(1, "turn_start", { turnSeq: 1, ...kept("p") }),
      w(2, "llm_call", { turnSeq: 1, model: "m" }),
      w(3, "tool_call", { turnSeq: 1, toolName: "Write", toolStatus: "ok" }),
      w(4, "turn_end", { turnSeq: 1 }),
    ];
    const folded = stepFolds(run);
    const [turn] = turnFolds(run, folded);
    expect(turn?.span.end).toBe(3);
    // The turn's span holds the call, so claiming from the turn's own span
    // could never find it.
    expect(
      toolUseClaimer(folded)(run[1] as RunFrame, [
        { name: "Write", callKey: null },
      ]),
    ).toEqual(["3"]);
  });

  it("claims nothing by name for a frame no step holds, or no frame (negative)", () => {
    const claim = toolUseClaimer(steps);
    expect(claim(w(99, "llm_call"), [{ name: "Read", callKey: null }])).toEqual(
      [null],
    );
    expect(claim(null, [{ name: "Bash", callKey: "k1" }])).toEqual(["3"]);
  });

  it("claims only on the reply's own chain (negative)", () => {
    const CHILD = "0192d4a8-7c1e-7a00-8000-0000000000c9";
    const run = [
      w(1, "turn_start", { turnSeq: 1 }),
      w(2, "llm_call", { turnSeq: 1, model: "m" }),
      s(CHILD, 0, "tool_call", {
        turnSeq: 1,
        toolName: "Read",
        toolStatus: "ok",
      }),
    ];
    expect(
      toolUseClaimer(stepFolds(run))(run[1] as RunFrame, [
        { name: "Read", callKey: null },
      ]),
    ).toEqual([null]);
  });
});

describe("recallOf", () => {
  const manifest = w(1, "steering.manifest", kept("m"));
  const said = (text: string): RecallBody => ({ state: "kept", text });
  /** An item the reading lists, with no reason, replacement or force recorded. */
  const listed = (
    kind: string,
    label: string,
    tokens: number | null,
    outcome: "included" | "cut" = "included",
  ) => ({
    kind,
    label,
    tokens,
    outcome,
    reason: null,
    supersededBy: null,
    force: null,
  });

  it("reads a steering manifest's items with the outcome of each, its cut and its tokens", () => {
    const body = JSON.stringify({
      schema: "oxagen.steering.manifest/1",
      included: 2,
      cut: 1,
      spent_tokens: 340,
      items: [
        { id: "rec_1", kind: "rule", tokens: 200, outcome: "included" },
        { id: "rec_2", kind: "fact", tokens: 140, outcome: "included" },
        { id: "rec_3", kind: "fact", tokens: 900, outcome: "cut" },
      ],
    });
    expect(recallOf(manifest, said(body))).toEqual({
      unit: "items",
      count: 2,
      tokens: 340,
      cut: 1,
      items: [
        listed("rule", "rec_1", 200),
        listed("fact", "rec_2", 140),
        listed("fact", "rec_3", 900, "cut"),
      ],
      bundleVersion: null,
      body: "listed",
    });
  });

  it("carries each item's force, the reason for a cut and what superseded it, and the bundle the manifest names", () => {
    // The shape the host seals (`steeringManifestFrameSchema`): each item's
    // outcome and force, and no `included` or `cut` of its own.
    const body = JSON.stringify({
      budget_tokens: 4000,
      spent_tokens: 340,
      bundle_version: 41,
      items: [
        {
          id: "rec_1",
          kind: "rule",
          force: "must",
          tokens: 200,
          outcome: "included",
        },
        {
          id: "rec_2",
          kind: "fact",
          force: "may",
          tokens: 900,
          outcome: "cut",
          reason: "budget",
        },
        {
          id: "rec_3",
          kind: "fact",
          force: "should",
          tokens: 140,
          outcome: "cut",
          reason: "superseded",
          superseded_by: "rec_1",
        },
      ],
    });
    expect(recallOf(manifest, said(body))).toEqual({
      unit: "items",
      count: 1,
      tokens: 340,
      cut: 2,
      items: [
        { ...listed("rule", "rec_1", 200), force: "must" },
        {
          ...listed("fact", "rec_2", 900, "cut"),
          force: "may",
          reason: "budget",
        },
        {
          ...listed("fact", "rec_3", 140, "cut"),
          force: "should",
          reason: "superseded",
          supersededBy: "rec_1",
        },
      ],
      bundleVersion: 41,
      body: "listed",
    });
  });

  it("reads an outcome it has no word for as a cut, never as delivered (negative)", () => {
    const body = JSON.stringify({
      items: [{ id: "rec_1", kind: "rule", tokens: 5, outcome: "withheld" }],
    });
    const recall = recallOf(manifest, said(body));
    expect(recall.items[0]?.outcome).toBe("cut");
    expect(recall.count).toBe(0);
    expect(recall.cut).toBe(1);
  });

  it("reads a context frame's listed frames, counting them when no total was recorded", () => {
    const body = JSON.stringify({
      tokens: 90,
      frames: [
        { type: "file", name: "a.ts", tok: 40 },
        { type: "file", label: "b.ts" },
        "not an item",
      ],
    });
    expect(recallOf(manifest, said(body))).toEqual({
      unit: "frames",
      count: 2,
      tokens: 90,
      cut: null,
      items: [listed("file", "a.ts", 40), listed("file", "b.ts", null)],
      bundleVersion: null,
      body: "listed",
    });
  });

  it("caps the listed items and keeps the recorded count", () => {
    const items = Array.from({ length: RECALL_ITEM_MAX + 5 }, (_, i) => ({
      id: `r${String(i)}`,
      kind: "fact",
      tokens: 1,
      outcome: "included",
    }));
    const recall = recallOf(
      manifest,
      said(JSON.stringify({ included: items.length, items })),
    );
    expect(recall.items).toHaveLength(RECALL_ITEM_MAX);
    expect(recall.count).toBe(RECALL_ITEM_MAX + 5);
  });

  it("falls back to the ledger's recorded frame count for a body it cannot read, and says why (negative)", () => {
    const selected = ledger(1, "context.frames_selected", { frame_count: 6 });
    const fallback = (body: TranscriptRecallBody) => ({
      unit: "frames",
      count: 6,
      tokens: null,
      cut: null,
      items: [],
      bundleVersion: null,
      body,
    });
    for (const text of ["not json", "[1,2]", JSON.stringify({ a: 1 })])
      expect(recallOf(selected, said(text))).toEqual(fallback("unlisted"));
    for (const state of ["unretained", "unreadable", "unlisted"] as const)
      expect(recallOf(selected, { state })).toEqual(fallback(state));
    expect(recallOf(manifest, { state: "unretained" }).count).toBeNull();
  });

  it("reads a count that is not a whole number, or is below zero, as none (negative)", () => {
    const body = JSON.stringify({
      included: -1,
      spent_tokens: 1.5,
      cut: "3",
      bundle_version: -2,
      items: [{ id: "r", kind: "fact", tokens: -4, outcome: "included" }],
    });
    // The recorded `cut` is not a count, so the cut is read from the items,
    // which say none was cut.
    expect(recallOf(manifest, said(body))).toEqual({
      unit: "items",
      count: 1,
      tokens: null,
      cut: 0,
      items: [listed("fact", "r", null)],
      bundleVersion: null,
      body: "listed",
    });
  });
});

describe("what a frame fold keeps of the old one", () => {
  it("sums usage across a model call's sightings without the duplicate's", () => {
    const first: RunFrame = w(1, "llm_call", {
      source: "transcript",
      body: JSON.stringify({ input_tokens: 12, output_tokens: 9 }),
      attrs: {},
    });
    const [step] = stepFolds([first]);
    expect(step?.usage).toEqual(first.usage);
  });
});
