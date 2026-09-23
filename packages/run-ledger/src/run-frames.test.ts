import { describe, expect, it } from "vitest";
import { NO_BODY } from "./frame-body";
import {
  bisectFrames,
  bisectKey,
  filterFramesByKind,
  foldTranscript,
  frameKinds,
  ledgerFrame,
  type RunFrame,
  stepKind,
  tachoFrame,
  tachoStage,
  tachoTimestamp,
  turnOrdinals,
} from "./run-frames";
import type { AttemptEventReadRecord } from "./run-store";

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

function tachoRow(
  seq: number,
  kind: string,
  over: Partial<Parameters<typeof tachoFrame>[0]> = {},
) {
  return {
    seq,
    ts: "2026-09-11 09:00:00.250",
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

describe("run frame projection", () => {
  it("maps a ledger event with its body columns, turn index and no cost record", () => {
    const frame = ledgerFrame(
      event(4, "model.call_completed", {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        turn_index: 2,
      }),
    );
    expect(frame.summary).toBe("anthropic/claude-sonnet-4-5");
    expect(frame.turnIndex).toBe(2);
    expect(frame.costMicros).toBeNull();
    expect(frame.identity.model).toBe("anthropic/claude-sonnet-4-5");
    expect(frame.body).toBe(NO_BODY);
  });

  it("labels each ledger receipt from its identifiers and falls back to the type", () => {
    const label = (type: string, payload: Record<string, unknown> | null) =>
      ledgerFrame(event(1, type, payload)).summary;
    expect(
      label("admission.run_admitted", {
        engine_name: "stella",
        engine_version: "2.1.0",
      }),
    ).toBe("stella@2.1.0");
    expect(label("context.frames_selected", { frame_count: 12 })).toBe(
      "frames=12",
    );
    expect(
      label("tool.call_completed", {
        capability_name: "read_file",
        outcome: "completed",
      }),
    ).toBe("read_file completed");
    expect(label("checkout.completed", { sha: "abc" })).toBe(
      "checkout.completed",
    );
    expect(label("tool.call_completed", { capability_name: "read_file" })).toBe(
      "tool.call_completed",
    );
  });

  it("maps an encrypted ledger receipt to its type alone", () => {
    const frame = ledgerFrame(event(5, "tool.call_completed", null));
    expect(frame.summary).toBe("tool.call_completed");
    expect(frame.identity).toEqual({
      tool: null,
      toolStatus: null,
      model: null,
      policy: null,
      verdict: null,
      contextRows: null,
      callId: null,
    });
  });

  it("maps a wrapped frame: a retained body is full, a digest alone is digest_only, no digest is no body", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const retained = tachoFrame(
      tachoRow(7, "tool_call", {
        contentDigest: digest,
        bytesRef: "evb:v1:k:" + "c".repeat(64),
        redactions:
          '[{"path":"bytes:0-4","reason":"jwt","original_digest":"sha256:' +
          "d".repeat(64) +
          '"}]',
        toolName: "Read",
        toolStatus: "ok",
        costUsdMicros: 12,
        turnSeq: 1,
      }),
    );
    expect(retained.body.fidelity).toBe("full");
    expect(retained.body.redactions).toHaveLength(1);
    expect(retained.summary).toBe("Read ok");
    expect(retained.stage).toBe("tool");
    expect(retained.costMicros).toBe(12);
    expect(retained.observedAt.toISOString()).toBe("2026-09-11T09:00:00.250Z");

    const digestOnly = tachoFrame(
      tachoRow(8, "llm_call", { contentDigest: digest }),
    );
    expect(digestOnly.body).toMatchObject({
      bodyRef: null,
      bodyDigest: digest,
      fidelity: "digest_only",
    });
    expect(tachoFrame(tachoRow(9, "agent_start")).body).toEqual(NO_BODY);
  });

  it("names a stage for every wrapped kind and reads the ClickHouse timestamp as UTC", () => {
    expect(tachoStage("llm_call")).toBe("model");
    expect(tachoStage("steering.manifest")).toBe("model");
    expect(tachoStage("policy_decision")).toBe("policy");
    expect(tachoStage("oxagen:compaction")).toBe("control");
    expect(tachoStage("telemetry_gap")).toBe("chain");
    expect(tachoTimestamp("2026-09-11T09:00:00.250Z").toISOString()).toBe(
      "2026-09-11T09:00:00.250Z",
    );
  });
});

describe("bisect", () => {
  const a = [
    tachoFrame(tachoRow(0, "agent_start")),
    tachoFrame(
      tachoRow(1, "tool_call", { toolName: "Read", toolStatus: "ok" }),
    ),
    tachoFrame(tachoRow(2, "llm_call", { model: "m", provider: "p" })),
  ];

  it("answers null for identical runs and the first differing key otherwise", () => {
    expect(bisectFrames(a, a)).toEqual({
      divergentSeq: null,
      keyA: null,
      keyB: null,
      aligned: 3,
    });
    const b = [
      a[0] as RunFrame,
      tachoFrame(
        tachoRow(1, "tool_call", { toolName: "Read", toolStatus: "denied" }),
      ),
      a[2] as RunFrame,
    ];
    expect(bisectFrames(a, b)).toEqual({
      divergentSeq: "1",
      keyA: "tool_call:Read=ok",
      keyB: "tool_call:Read=denied",
      aligned: 1,
    });
  });

  it("treats a strict prefix as diverging at the first frame the longer run has alone", () => {
    expect(bisectFrames(a.slice(0, 2), a)).toEqual({
      divergentSeq: "2",
      keyA: null,
      keyB: "llm_call:p/m",
      aligned: 2,
    });
    expect(bisectFrames([], [])).toEqual({
      divergentSeq: null,
      keyA: null,
      keyB: null,
      aligned: 0,
    });
  });

  it("keys on the receipt, never on the body", () => {
    const withBody = tachoFrame(
      tachoRow(1, "tool_call", {
        toolName: "Read",
        toolStatus: "ok",
        contentDigest: `sha256:${"e".repeat(64)}`,
      }),
    );
    expect(bisectKey(withBody)).toBe(bisectKey(a[1] as RunFrame));
  });
});

describe("transcript fold", () => {
  const frames = [
    tachoFrame(tachoRow(0, "agent_start")),
    tachoFrame(tachoRow(1, "turn_start", { turnSeq: 1 })),
    tachoFrame(
      tachoRow(2, "llm_call", { model: "m", costUsdMicros: 5, turnSeq: 1 }),
    ),
    tachoFrame(tachoRow(3, "tool_call", { toolName: "Read", turnSeq: 1 })),
    tachoFrame(
      tachoRow(4, "policy_decision", { policyDecision: "allow", turnSeq: 1 }),
    ),
    tachoFrame(tachoRow(5, "turn_start", { turnSeq: 2 })),
    tachoFrame(
      tachoRow(6, "llm_call", { model: "m", costUsdMicros: 7, turnSeq: 2 }),
    ),
    tachoFrame(tachoRow(7, "agent_stop")),
  ];

  it("everything is one entry per frame", () => {
    const folded = foldTranscript(frames, "everything");
    expect(folded).toHaveLength(8);
    expect(folded.map((f) => f.kind)).toEqual([
      "frame",
      "frame",
      "model_call",
      "tool_call",
      // A decision frame is its own entry at this zoom, and says so.
      "policy",
      "frame",
      "model_call",
      "frame",
    ]);
  });

  it("leaves non-step openings out of request and response slots", () => {
    // turn_start, policy_decision and agent_start open an entry but are not
    // halves of a call. Putting them in response by default labelled a turn
    // prompt as something that came back, and at turns zoom blocked the
    // real model response from absorbing into the same entry.
    const folded = foldTranscript(frames, "everything");
    const agentStart = folded[0]!;
    const turnStart = folded[1]!;
    const policy = folded[4]!;
    const llm = folded[2]!;
    expect(stepKind(agentStart.opening)).toBeNull();
    expect(stepKind(turnStart.opening)).toBeNull();
    expect(stepKind(policy.opening)).toBeNull();
    expect([agentStart.request, agentStart.response]).toEqual([null, null]);
    expect([turnStart.request, turnStart.response]).toEqual([null, null]);
    expect([policy.request, policy.response]).toEqual([null, null]);
    // A step half still fills its own slot when it opens the entry.
    expect(llm.response?.seq).toBe("2");
    expect(llm.request).toBeNull();
  });

  it("at turns zoom, absorbs the model response after an opening turn_start", () => {
    const folded = foldTranscript(frames, "turns");
    const turn = folded[1]!;
    expect(turn.opening.type).toBe("turn_start");
    expect(turn.request).toBeNull();
    expect(turn.response?.type).toBe("llm_call");
    expect(turn.response?.seq).toBe("2");
  });

  it("steps opens at model and tool calls, folding the rest into the step before except a policy decision, which holds for the step after", () => {
    const folded = foldTranscript(frames, "steps");
    expect(
      folded.map((f) => [f.opening.seq, f.endSeq, f.kind, f.frames]),
    ).toEqual([
      ["0", "1", "frame", 2],
      ["2", "2", "model_call", 1],
      // policy_decision (seq 4) holds out of this step and attaches to the
      // model_call that opens next, so this entry's frame count drops by one.
      ["3", "5", "tool_call", 2],
      ["6", "7", "model_call", 3],
    ]);
    expect(folded[1]?.costMicros).toBe(5);
    expect(folded[0]?.costMicros).toBeNull();
  });

  it("attaches a pre-call policy decision to the step it governs, not the step before it", () => {
    // hook-handler.ts emits `policy_decision` immediately before
    // `tool_requested` on PreToolUse: the decision names the call about to
    // run, not the one that just finished.
    const wrapped = [
      tachoFrame(tachoRow(0, "llm_call", { model: "m" })),
      tachoFrame(tachoRow(1, "policy_decision", { policyDecision: "allow" })),
      tachoFrame(tachoRow(2, "tool_requested", { toolName: "Read" })),
      tachoFrame(
        tachoRow(3, "tool_call", { toolName: "Read", toolStatus: "ok" }),
      ),
    ];
    const folded = foldTranscript(wrapped, "steps");
    expect(folded.map((f) => [f.opening.seq, f.kind])).toEqual([
      ["0", "model_call"],
      ["2", "tool_call"],
    ]);
    expect(folded[0]?.decision).toBeNull();
    expect(folded[1]?.decision?.decision).toBe("allow");
    expect(folded[1]?.request?.seq).toBe("2");
    expect(folded[1]?.response?.seq).toBe("3");
  });

  it("falls back to the last step when a run ends on a pending policy decision", () => {
    const wrapped = [
      tachoFrame(tachoRow(0, "tool_requested", { toolName: "Read" })),
      tachoFrame(
        tachoRow(1, "tool_call", { toolName: "Read", toolStatus: "ok" }),
      ),
      tachoFrame(tachoRow(2, "policy_decision", { policyDecision: "deny" })),
    ];
    const folded = foldTranscript(wrapped, "steps");
    expect(folded).toHaveLength(1);
    expect(folded[0]?.decision?.decision).toBe("deny");
    expect(folded[0]?.endSeq).toBe("1");
  });

  it("buffers a filtered pre-call policy for the next tool step (finding 4052307523)", () => {
    // kinds=policy,tools drops the model response that normally closes the
    // preceding step, so the decision meets a null current (or a model fold
    // with response null) and must still attach to the tool it gates.
    const unfiltered = [
      tachoFrame(tachoRow(0, "llm_call", { model: "m" })),
      tachoFrame(tachoRow(1, "policy_decision", { policyDecision: "allow" })),
      tachoFrame(tachoRow(2, "tool_requested", { toolName: "Read" })),
      tachoFrame(
        tachoRow(3, "tool_call", { toolName: "Read", toolStatus: "ok" }),
      ),
    ];
    const filtered = filterFramesByKind(unfiltered, ["policy", "tools"]);
    expect(filtered.map((f) => f.type)).toEqual([
      "policy_decision",
      "tool_requested",
      "tool_call",
    ]);
    const folded = foldTranscript(filtered, "steps");
    expect(folded.map((f) => [f.opening.seq, f.kind])).toEqual([
      ["2", "tool_call"],
    ]);
    expect(folded[0]?.decision?.decision).toBe("allow");
    expect(folded[0]?.request?.seq).toBe("2");
    expect(folded[0]?.response?.seq).toBe("3");
  });

  it("buffers a pre-call policy when the model response was filtered but the request remains", () => {
    const frames = [
      tachoFrame(tachoRow(0, "model.request", { model: "m" })),
      tachoFrame(tachoRow(1, "model.response", { model: "m" })),
      tachoFrame(tachoRow(2, "policy_decision", { policyDecision: "deny" })),
      tachoFrame(tachoRow(3, "tool_requested", { toolName: "Bash" })),
      tachoFrame(
        tachoRow(4, "tool_call", { toolName: "Bash", toolStatus: "ok" }),
      ),
    ];
    // Keep prompt so the model request survives, drop responses so the fold
    // still looks open when the policy arrives.
    const filtered = filterFramesByKind(frames, ["prompt", "policy", "tools"]);
    expect(filtered.map((f) => f.type)).toEqual([
      "model.request",
      "policy_decision",
      "tool_requested",
      "tool_call",
    ]);
    const folded = foldTranscript(filtered, "steps");
    expect(folded.map((f) => [f.opening.seq, f.kind])).toEqual([
      ["0", "model_call"],
      ["3", "tool_call"],
    ]);
    expect(folded[0]?.decision).toBeNull();
    expect(folded[1]?.decision?.decision).toBe("deny");
  });

  it("turns opens at turn_start and sums the turn's cost records", () => {
    const folded = foldTranscript(frames, "turns");
    expect(
      folded.map((f) => [f.opening.seq, f.endSeq, f.frames, f.costMicros]),
    ).toEqual([
      ["0", "0", 1, null],
      ["1", "4", 4, 5],
      ["5", "7", 3, 7],
    ]);
  });

  it("turns falls back to the turn index when the recording has no boundaries, and one turn when it has neither", () => {
    const ledger = [
      ledgerFrame(
        event(1, "admission.run_admitted", {
          engine_name: "stella",
          engine_version: "1",
        }),
      ),
      ledgerFrame(event(2, "model.call_completed", { turn_index: 0 })),
      ledgerFrame(
        event(3, "tool.call_completed", {
          capability_name: "read_file",
          outcome: "completed",
        }),
      ),
      ledgerFrame(event(4, "model.call_completed", { turn_index: 1 })),
    ];
    expect(
      foldTranscript(ledger, "turns").map((f) => [f.opening.seq, f.endSeq]),
    ).toEqual([
      ["1", "3"],
      ["4", "4"],
    ]);
    const oneTurn = ledger.map((f) => ({ ...f, turnIndex: null }));
    expect(foldTranscript(oneTurn, "turns")).toHaveLength(1);
    expect(foldTranscript([], "turns")).toEqual([]);
  });

  it("turnOrdinals counts turn_start frames and leaves the frames before the first in no turn", () => {
    expect(turnOrdinals(frames)).toEqual([null, 1, 1, 1, 1, 2, 2, 2]);
  });

  it("turnOrdinals follows the turn index without boundaries, and puts every frame in one turn when it has neither", () => {
    const ledger = [
      ledgerFrame(event(1, "admission.run_admitted", null)),
      ledgerFrame(event(2, "model.call_completed", { turn_index: 0 })),
      ledgerFrame(event(3, "tool.call_completed", null)),
      ledgerFrame(event(4, "model.call_completed", { turn_index: 1 })),
    ];
    expect(turnOrdinals(ledger)).toEqual([1, 1, 1, 2]);
    expect(
      turnOrdinals(ledger.map((f) => ({ ...f, turnIndex: null }))),
    ).toEqual([1, 1, 1, 1]);
    expect(turnOrdinals([])).toEqual([]);
  });
});

describe("the engine's own call halves", () => {
  it("names the tool by `tool_name`, pairs on `tool_call_id`, and phases the two halves", () => {
    const started = ledgerFrame(
      event(1, "tool.engine_call_started", {
        tool_call_id: "tc_1",
        tool_name: "read_file",
        input_digest: `sha256:${"b".repeat(64)}`,
      }),
    );
    const completed = ledgerFrame(
      event(2, "tool.engine_call_completed", {
        tool_call_id: "tc_1",
        tool_name: "read_file",
        outcome: "completed",
        input_digest: `sha256:${"b".repeat(64)}`,
        duration_ms: 12,
      }),
    );
    expect(started.phase).toBe("request");
    expect(completed.phase).toBe("response");
    expect(started.summary).toBe("read_file");
    expect(completed.summary).toBe("read_file completed");
    expect(started.identity.callId).toBe("tc_1");
    expect(completed.identity.tool).toBe("read_file");
    // A submitted engine's single receipt stands for the whole exchange.
    expect(
      ledgerFrame(event(3, "tool.call_completed", { capability_name: "x" }))
        .phase,
    ).toBe("single");
  });

  it("folds an engine tool exchange into ONE step carrying both halves", () => {
    const frames = [
      ledgerFrame(
        event(1, "tool.engine_call_started", {
          tool_call_id: "tc_1",
          tool_name: "read_file",
          input_digest: `sha256:${"b".repeat(64)}`,
        }),
      ),
      ledgerFrame(
        event(2, "tool.engine_call_completed", {
          tool_call_id: "tc_1",
          tool_name: "read_file",
          outcome: "completed",
          input_digest: `sha256:${"b".repeat(64)}`,
          duration_ms: 12,
        }),
      ),
    ];
    const folded = foldTranscript(frames, "steps");
    expect(folded).toHaveLength(1);
    expect(folded[0]?.kind).toBe("tool_call");
    expect(folded[0]?.request?.seq).toBe("1");
    expect(folded[0]?.response?.seq).toBe("2");
  });

  it("does not pair two halves of different calls", () => {
    const frames = [
      ledgerFrame(
        event(1, "tool.engine_call_started", {
          tool_call_id: "tc_1",
          tool_name: "a",
          input_digest: `sha256:${"b".repeat(64)}`,
        }),
      ),
      ledgerFrame(
        event(2, "tool.engine_call_completed", {
          tool_call_id: "tc_2",
          tool_name: "b",
          outcome: "completed",
          input_digest: `sha256:${"c".repeat(64)}`,
          duration_ms: 1,
        }),
      ),
    ];
    const folded = foldTranscript(frames, "steps");
    expect(folded).toHaveLength(2);
    expect(folded[0]?.response).toBeNull();
    expect(folded[1]?.request).toBeNull();
  });

  it("matches an overlapping call's completion to its own request, not to whichever call opened most recently (finding 5, negative)", () => {
    // start A, start B, complete A, complete B: parallel tool calls are the
    // ordinary case. Comparing a response only against the most recently
    // opened step matched neither completion, splitting two calls into four
    // entries with every response detached from its request.
    const frames = [
      ledgerFrame(
        event(1, "tool.engine_call_started", {
          tool_call_id: "tc_a",
          tool_name: "a",
          input_digest: `sha256:${"a".repeat(64)}`,
        }),
      ),
      ledgerFrame(
        event(2, "tool.engine_call_started", {
          tool_call_id: "tc_b",
          tool_name: "b",
          input_digest: `sha256:${"b".repeat(64)}`,
        }),
      ),
      ledgerFrame(
        event(3, "tool.engine_call_completed", {
          tool_call_id: "tc_a",
          tool_name: "a",
          outcome: "completed",
          input_digest: `sha256:${"a".repeat(64)}`,
          duration_ms: 1,
        }),
      ),
      ledgerFrame(
        event(4, "tool.engine_call_completed", {
          tool_call_id: "tc_b",
          tool_name: "b",
          outcome: "completed",
          input_digest: `sha256:${"b".repeat(64)}`,
          duration_ms: 1,
        }),
      ),
    ];
    const folded = foldTranscript(frames, "steps");
    expect(folded).toHaveLength(2);
    expect(folded[0]?.request?.seq).toBe("1");
    expect(folded[0]?.response?.seq).toBe("3");
    expect(folded[1]?.request?.seq).toBe("2");
    expect(folded[1]?.response?.seq).toBe("4");
  });

  it("pairs overlapping wrapped tool calls on toolUseId the same way (negative)", () => {
    // Without callId, adjacency attaches A's result to B and leaves B's
    // result detached. TachoFrameRow already carries toolUseId.
    const frames = [
      tachoFrame(
        tachoRow(1, "tool_requested", { toolName: "a", toolUseId: "tu_a" }),
      ),
      tachoFrame(
        tachoRow(2, "tool_requested", { toolName: "b", toolUseId: "tu_b" }),
      ),
      tachoFrame(
        tachoRow(3, "tool_call", {
          toolName: "a",
          toolUseId: "tu_a",
          toolStatus: "ok",
        }),
      ),
      tachoFrame(
        tachoRow(4, "tool_call", {
          toolName: "b",
          toolUseId: "tu_b",
          toolStatus: "ok",
        }),
      ),
    ];
    expect(frames.map((f) => f.identity.callId)).toEqual([
      "tu_a",
      "tu_b",
      "tu_a",
      "tu_b",
    ]);
    const folded = foldTranscript(frames, "steps");
    expect(folded).toHaveLength(2);
    expect(folded[0]?.request?.seq).toBe("1");
    expect(folded[0]?.response?.seq).toBe("3");
    expect(folded[1]?.request?.seq).toBe("2");
    expect(folded[1]?.response?.seq).toBe("4");
  });

  it("a model engine call opens a step: it used to fold into whatever came before it", () => {
    const frames = [
      ledgerFrame(event(1, "admission.run_admitted", { engine_name: "s" })),
      ledgerFrame(
        event(2, "model.engine_call_completed", {
          engine_seq: 1,
          model_call_id: "mc_1",
          role: "assistant",
          provider: "anthropic",
          model: "haiku",
          outcome: "completed",
        }),
      ),
    ];
    const folded = foldTranscript(frames, "steps");
    expect(folded.map((f) => [f.opening.seq, f.kind])).toEqual([
      ["1", "frame"],
      ["2", "model_call"],
    ]);
    expect(folded[1]?.opening.summary).toBe("anthropic/haiku");
  });
});

describe("frameKinds and filterFramesByKind", () => {
  const model = ledgerFrame(
    event(1, "model.engine_call_started", {
      engine_seq: 1,
      model_call_id: "mc_1",
      role: "assistant",
      provider: "anthropic",
      model: "haiku",
    }),
  );
  const tool = tachoFrame(
    tachoRow(2, "tool_call", { toolName: "Read", toolStatus: "failed" }),
  );
  const usage = tachoFrame(
    tachoRow(3, "llm_call", { model: "m", costUsdMicros: 9 }),
  );
  const policy = tachoFrame(
    tachoRow(4, "policy_decision", { policyDecision: "deny" }),
  );
  const recall = ledgerFrame(
    event(5, "context.frames_selected", { frame_count: 3 }),
  );

  it("derives every chip a frame answers to", () => {
    expect(frameKinds(model)).toEqual(["prompt"]);
    expect(frameKinds(tool).sort()).toEqual(["errors", "tools"]);
    expect(frameKinds(usage).sort()).toEqual(["responses", "usage"]);
    expect(frameKinds(policy)).toEqual(["policy"]);
    expect(frameKinds(recall)).toEqual(["recall"]);
  });

  it("keeps everything for an empty selection, and only the chips pressed otherwise", () => {
    const frames = [model, tool, usage, policy, recall];
    expect(filterFramesByKind(frames, [])).toHaveLength(5);
    expect(filterFramesByKind(frames, ["errors"]).map((f) => f.seq)).toEqual([
      "2",
    ]);
    expect(
      filterFramesByKind(frames, ["prompt", "recall"]).map((f) => f.seq),
    ).toEqual(["1", "5"]);
  });
});

describe("the steps zoom on a run the in-app assistant recorded", () => {
  // The assistant writes `model.engine_call_completed` and
  // `tool.engine_call_completed`, and it is the only ledger producer in the
  // tree. This list named neither, so every one of its runs folded into a
  // single `frame` entry however many calls it made.
  const assistant = [
    ledgerFrame(
      event(1, "admission.run_admitted", {
        engine_name: "stella",
        engine_version: "1",
      }),
    ),
    ledgerFrame(
      event(2, "model.engine_call_started", { model_call_id: "prov-1-0" }),
    ),
    ledgerFrame(
      event(3, "model.engine_call_completed", {
        model_call_id: "prov-1-0",
        turn_index: 0,
      }),
    ),
    ledgerFrame(
      event(4, "tool.engine_call_started", { tool_call_id: "tool-1-0" }),
    ),
    ledgerFrame(
      event(5, "tool.engine_call_completed", {
        tool_call_id: "tool-1-0",
        outcome: "completed",
      }),
    ),
  ];

  it("opens a step at its intention and closes it at the completion, so both halves are one entry", () => {
    expect(
      foldTranscript(assistant, "steps").map((f) => [
        f.opening.seq,
        f.endSeq,
        f.kind,
        f.frames,
      ]),
    ).toEqual([
      ["1", "1", "frame", 1],
      ["2", "3", "model_call", 2],
      ["4", "5", "tool_call", 2],
    ]);
  });

  it("puts each call's request on the same entry as its result", () => {
    // Why the intention opens the step rather than folding into what came
    // before it: the entry carries `request` and `response`, and the request
    // is on the intention. Folding intentions into the preceding entry put
    // the model call's prompt in the entry before it and the tool call's
    // input inside the MODEL step — each call's request stranded away from
    // the call it belongs to. An intention is still not a step of its own;
    // it is the frame its step opens on.
    const [, model, tool] = foldTranscript(assistant, "steps");
    expect([model?.request?.seq, model?.response?.seq]).toEqual(["2", "3"]);
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

describe("a frame's summary and identity on a run the assistant recorded", () => {
  const modelFrame = ledgerFrame(
    event(1, "model.engine_call_completed", {
      model_call_id: "prov-1-0",
      provider: "oxagen",
      model: "anthropic/claude-sonnet-4",
      outcome: "completed",
    }),
  );
  const toolFrame = ledgerFrame(
    event(2, "tool.engine_call_completed", {
      tool_call_id: "tool-1-0",
      tool_name: "search_tools",
      outcome: "completed",
    }),
  );

  it("names the model and the tool instead of falling through to the event type", () => {
    expect(modelFrame.summary).toBe("oxagen/anthropic/claude-sonnet-4");
    expect(modelFrame.identity.model).toBe("oxagen/anthropic/claude-sonnet-4");
    // The engine event calls it `tool_name` where the ledger's own event
    // calls it `capability_name`; both read.
    expect(toolFrame.summary).toBe("search_tools completed");
    expect(toolFrame.identity.tool).toBe("search_tools");
    expect(toolFrame.identity.toolStatus).toBe("completed");
  });

  it("reads no turn index, because the engine event carries none", () => {
    expect(modelFrame.turnIndex).toBeNull();
  });
});
