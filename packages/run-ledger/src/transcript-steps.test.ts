// The one transcript fold (ADR-182). The step rules here were the Run page's
// (apps/app/src/features/run/transcript-model.test.ts) and the server's
// (run-frames.test.ts) until the two folds became this one; their cases are
// ported so the behaviour each pinned stays pinned where the rule now lives.
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
  frameFolds,
  RECALL_ITEM_MAX,
  recallOf,
  stepFolds,
  toolUseClaimer,
  type TranscriptFold,
  transcriptCounts,
  turnFolds,
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

  it("marks a message that repeats the operator's prompt, and a reply that repeats the last one", () => {
    const reply = (seq: number, digest: string, over = {}) =>
      w(seq, "turn_end", { turnSeq: 1, ...kept(digest), ...over });
    const folded = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
      reply(2, "prompt"),
      reply(3, "answer"),
      reply(4, "answer"),
      reply(5, "other"),
    ]);
    expect(folded.map((f) => [f.key, f.echoOf])).toEqual([
      ["1", null],
      ["2", "1"],
      ["3", null],
      ["4", "3"],
      ["5", null],
    ]);
  });

  it("keeps a subagent's message that repeats the operator's words, and never echoes across turns (negative)", () => {
    const folded = stepFolds([
      w(1, "turn_start", { turnSeq: 1, ...kept("prompt") }),
      s(SUB, 0, "turn_end", kept("prompt")),
      w(2, "turn_start", { turnSeq: 2, ...kept("prompt2") }),
      w(3, "turn_end", { turnSeq: 2, ...kept("prompt") }),
    ]);
    expect(folded.map((f) => f.echoOf)).toEqual([null, null, null, null]);
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
        w(1, "llm_call", { model: "m", turnSeq: 1 }),
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

describe("transcriptCounts", () => {
  it("counts every entry per chip, the entries with something to show, errors and decisions", () => {
    const folds = frameFolds([
      w(0, "agent_start"),
      w(1, "turn_start", { turnSeq: 1, ...kept("p") }),
      w(2, "llm_call", { model: "m", costUsdMicros: 3 }),
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
  const model = nth(steps, 1);

  it("claims a block by its call key, then by name for the next unclaimed step after the reply", () => {
    const claim = toolUseClaimer(steps);
    expect(
      claim(model, [
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
      claim(model, [
        { name: "Grep", callKey: null },
        { name: "Edit", callKey: "k9" },
      ]),
    ).toEqual([null, null]);
  });

  it("does not claim a keyed step by name for a block that kept a different key (negative)", () => {
    const claim = toolUseClaimer(steps);
    expect(claim(model, [{ name: "Bash", callKey: "k2" }])).toEqual([null]);
  });
});

describe("recallOf", () => {
  const manifest = w(1, "steering.manifest", kept("m"));

  it("reads a steering manifest's included items, its cut and its tokens", () => {
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
    expect(recallOf(manifest, body)).toEqual({
      unit: "items",
      count: 2,
      tokens: 340,
      cut: 1,
      items: [
        { kind: "rule", label: "rec_1", tokens: 200 },
        { kind: "fact", label: "rec_2", tokens: 140 },
      ],
    });
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
    expect(recallOf(manifest, body)).toEqual({
      unit: "frames",
      count: 2,
      tokens: 90,
      cut: null,
      items: [
        { kind: "file", label: "a.ts", tokens: 40 },
        { kind: "file", label: "b.ts", tokens: null },
      ],
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
      JSON.stringify({ included: items.length, items }),
    );
    expect(recall.items).toHaveLength(RECALL_ITEM_MAX);
    expect(recall.count).toBe(RECALL_ITEM_MAX + 5);
  });

  it("falls back to the ledger's recorded frame count for a body it cannot read (negative)", () => {
    const selected = ledger(1, "context.frames_selected", { frame_count: 6 });
    for (const body of [null, "not json", "[1,2]", JSON.stringify({ a: 1 })]) {
      expect(recallOf(selected, body)).toEqual({
        unit: "frames",
        count: 6,
        tokens: null,
        cut: null,
        items: [],
      });
    }
    expect(recallOf(manifest, null).count).toBeNull();
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
