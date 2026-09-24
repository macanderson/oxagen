import { describe, expect, it } from "vitest";
import { NO_BODY } from "./frame-body";
import {
  bisectFrames,
  bisectKey,
  filterFramesByKind,
  foldTranscript,
  frameKey,
  frameKinds,
  ledgerFrame,
  spliceSubagentChains,
  withoutDuplicateModelCalls,
  type RunFrame,
  stepKind,
  tachoFrame,
  tachoTimestamp,
  turnOrdinals,
} from "./run-frames";
import { tachoStage } from "./tacho-kinds";
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

  it("reads a harness-reported agent message as a response, and leaves other messages single", () => {
    const digest = `sha256:${"e".repeat(64)}`;
    const reply = tachoFrame(
      tachoRow(10, "oxagen:message", {
        contentDigest: digest,
        bytesRef: "evb:v1:k:" + "e".repeat(64),
        body: JSON.stringify({
          last_assistant_message_digest: digest,
          response_length: 12,
          message_final: true,
        }),
      }),
    );
    expect(reply.phase).toBe("response");
    const prompt = tachoFrame(
      tachoRow(11, "oxagen:message", {
        body: JSON.stringify({ prompt_digest: digest, prompt_length: 3 }),
      }),
    );
    expect(prompt.phase).toBe("single");
    const delta = tachoFrame(
      tachoRow(12, "oxagen:message", {
        body: JSON.stringify({ response_digest: digest }),
      }),
    );
    expect(delta.phase).toBe("single");
    expect(tachoFrame(tachoRow(13, "oxagen:message")).phase).toBe("single");
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

  // #3370: the chips of a fold are collected from every frame it absorbs, so
  // a failed tool call behind a model response still marks the turn.
  it("collects the chips of every frame a fold absorbs, beyond its opening and halves", () => {
    const folded = foldTranscript(
      [
        tachoFrame(tachoRow(0, "turn_start", { turnSeq: 1 })),
        tachoFrame(tachoRow(1, "llm_call", { model: "m", turnSeq: 1 })),
        tachoFrame(
          tachoRow(2, "tool_call", {
            toolName: "Read",
            toolStatus: "failed",
            turnSeq: 1,
          }),
        ),
      ],
      "turns",
    );
    expect(folded).toHaveLength(1);
    const turn = folded[0]!;
    expect(turn.response?.seq).toBe("1");
    expect([...turn.kinds].sort()).toEqual([
      "errors",
      "prompt",
      "responses",
      "tools",
    ]);
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

  // An operator's pause, resume, cancel or steer is a decision the Policies
  // tab lists, with the command as its word and the operator as its source
  // (#4023). It is about the run, so it never becomes the decision of the
  // call a step fold holds.
  describe("an operator command", () => {
    const applied = (seq: number, command: string) =>
      tachoFrame(
        tachoRow(seq, "oxagen:command_applied", {
          policyDecision: command === "resume" ? "allow" : "deny",
          attrs: { "command.id": `tcm_${seq}`, "command.name": command },
          body: JSON.stringify({
            policy_decision: command === "resume" ? "allow" : "deny",
            policy_source: "human",
            policy_reason_code: `${command}_applied`,
          }),
        }),
      );

    it("reads as a policy frame whose decision is the command, by the operator", () => {
      const frame = applied(3, "pause");
      expect(frame.stage).toBe("policy");
      expect(frame.summary).toBe("operator pause");
      expect(frame.identity.policy).toBe("pause");
      expect(frame.identity.policySource).toBe("human");
      expect(frameKinds(frame)).toContain("policy");
      const [entry] = foldTranscript([frame], "everything");
      expect(entry?.kind).toBe("policy");
      expect(entry?.decision).toMatchObject({
        seq: "3",
        decision: "pause",
        type: "oxagen:command_applied",
        source: "human",
      });
    });

    it("records who decided a policy frame from its body", () => {
      const frame = tachoFrame(
        tachoRow(1, "policy_decision", {
          policyDecision: "allow",
          body: JSON.stringify({
            policy_decision: "allow",
            policy_source: "harness",
          }),
        }),
      );
      expect(foldTranscript([frame], "everything")[0]?.decision?.source).toBe(
        "harness",
      );
    });

    it("does not become the decision of the step it folds into", () => {
      const folded = foldTranscript(
        [
          tachoFrame(tachoRow(0, "tool_requested", { toolName: "Read" })),
          applied(1, "steer"),
          tachoFrame(
            tachoRow(2, "tool_call", { toolName: "Read", toolStatus: "ok" }),
          ),
        ],
        "steps",
      );
      expect(folded).toHaveLength(1);
      expect(folded[0]?.decision).toBeNull();
      expect(folded[0]?.frames).toBe(3);
    });
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

  // #3370 finding 11: tacho's tool outcomes are ok, error, rejected and
  // cancelled. A call the harness rejected did not do what it was asked, so
  // the errors chip must keep it.
  it("answers errors for a wrapped tool call the harness rejected", () => {
    const rejected = tachoFrame(
      tachoRow(12, "tool_call", { toolName: "Bash", toolStatus: "rejected" }),
    );
    const ok = tachoFrame(
      tachoRow(13, "tool_call", { toolName: "Bash", toolStatus: "ok" }),
    );
    expect(frameKinds(rejected).sort()).toEqual(["errors", "tools"]);
    expect(frameKinds(ok)).toEqual(["tools"]);
    expect(
      filterFramesByKind([ok, rejected], ["errors"]).map((f) => f.seq),
    ).toEqual(["12"]);
  });

  it("counts the prompt an operator typed, once, and not a subagent's", () => {
    const typed = tachoFrame(tachoRow(6, "turn_start", { turnSeq: 1 }));
    const handed = tachoFrame(
      tachoRow(7, "turn_start", {
        sessionUuid: "sub",
        rootSessionUuid: "root",
      }),
    );
    // The transcript tailer's copy of the same prompt.
    const copy = tachoFrame(
      tachoRow(8, "oxagen:message", {
        body: JSON.stringify({ prompt_digest: "sha256:ab", prompt_length: 3 }),
      }),
    );
    expect(frameKinds(typed)).toEqual(["prompt"]);
    expect(frameKinds(handed)).toEqual([]);
    expect(frameKinds(copy)).toEqual([]);
    expect(
      filterFramesByKind([typed, handed, copy, tool], ["prompt"]).map(
        (f) => f.seq,
      ),
    ).toEqual(["6"]);
  });

  it("answers thinking for a call that reasoned, and seal for the chain's own integrity frames", () => {
    const reasoned = {
      ...usage,
      usage: {
        inputUncached: null,
        cacheRead: null,
        cacheWrite: null,
        output: 40,
        reasoning: 12,
      },
    };
    const plain = { ...usage, usage: { ...reasoned.usage, reasoning: 0 } };
    const checkpoint = tachoFrame(tachoRow(9, "checkpoint"));
    const gap = tachoFrame(tachoRow(10, "telemetry_gap"));
    const terminated = ledgerFrame({
      ...event(11, "terminal.attempt_terminated", {}),
      stage: "terminal",
    });
    expect(frameKinds(reasoned).sort()).toEqual([
      "responses",
      "thinking",
      "usage",
    ]);
    expect(frameKinds(plain)).not.toContain("thinking");
    expect(frameKinds(checkpoint)).toEqual(["seal"]);
    expect(frameKinds(gap)).toEqual(["seal"]);
    expect(frameKinds(terminated)).toEqual(["seal"]);
    expect(frameKinds(tool)).not.toContain("seal");
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

describe("reported frame usage", () => {
  it("keeps missing counts unknown and excludes duplicate model reports", () => {
    const first = tachoFrame(
      tachoRow(1, "llm_call", {
        source: "transcript",
        body: JSON.stringify({
          input_tokens: 12,
          cache_read_tokens: 400,
          output_tokens: 9,
        }),
        attrs: {},
      }),
    );
    expect(first.usage).toEqual({
      inputUncached: 12,
      cacheRead: 400,
      cacheWrite: null,
      output: 9,
      reasoning: null,
    });
    const duplicate = tachoFrame(
      tachoRow(2, "llm_call", {
        source: "otel_log",
        attrs: { "oxagen.llm_call_duplicate_of": "transcript" },
        body: JSON.stringify({ input_tokens: 12, output_tokens: 9 }),
      }),
    );
    expect(duplicate.usage).toBeNull();
    expect(foldTranscript([first, duplicate], "turns")[0]?.usage).toEqual(
      first.usage,
    );
  });
});

describe("transcript reasoning splits", () => {
  it("retains reasoning from a duplicate transcript without recounting its input or output", () => {
    const first = tachoFrame(
      tachoRow(1, "llm_call", {
        source: "otel_log",
        attrs: {},
        body: JSON.stringify({ input_tokens: 12, output_tokens: 9 }),
      }),
    );
    const transcript = tachoFrame(
      tachoRow(2, "llm_call", {
        source: "transcript",
        attrs: { "oxagen.llm_call_duplicate_of": "otel_log" },
        body: JSON.stringify({
          input_tokens: 12,
          output_tokens: 9,
          thinking_tokens: 4,
        }),
      }),
    );
    const continuation = tachoFrame(
      tachoRow(3, "llm_call", {
        source: "transcript",
        attrs: { "oxagen.llm_call_duplicate_of": "transcript" },
        body: JSON.stringify({
          input_tokens: 12,
          output_tokens: 9,
          thinking_tokens: 4,
        }),
      }),
    );
    expect(transcript.usage).toEqual({
      inputUncached: null,
      cacheRead: null,
      cacheWrite: null,
      output: null,
      reasoning: 4,
    });
    expect(continuation.usage).toBeNull();
    expect(
      foldTranscript([first, transcript, continuation], "turns")[0]?.usage,
    ).toEqual({
      inputUncached: 12,
      cacheRead: null,
      cacheWrite: null,
      output: 9,
      reasoning: 4,
    });
  });
});

const ROOT_UUID = "0192d4a8-7c1e-7a00-8000-00000000000a";
const CHILD_A = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const CHILD_B = "0192d4a8-7c1e-7a00-8000-0000000000c2";
const GRANDCHILD = "0192d4a8-7c1e-7a00-8000-0000000000c3";

/** A frame on a subagent's chain, as the run-wide read returns it. */
function childRow(
  session: string,
  seq: number,
  kind: string,
  over: Partial<Parameters<typeof tachoFrame>[0]> = {},
  parent = ROOT_UUID,
) {
  return tachoRow(seq, kind, {
    sessionUuid: session,
    rootSessionUuid: ROOT_UUID,
    parentSessionUuid: parent,
    subagentId: `agent-${session.slice(-2)}`,
    subagentType: "Explore",
    spawnToolUseId: `toolu_task_${session.slice(-2)}`,
    ...over,
  });
}

const at = (second: number) =>
  `2026-09-11 09:00:${String(second).padStart(2, "0")}.000`;

describe("subagent chains in the run's frames", () => {
  // Subagent work used to reach no transcript: the run read only the root
  // session's chain, while its cost counted every chain under the root.
  it("projects a subagent row's chain, and a spawn's subagent (negative: a root row names none)", () => {
    const child = tachoFrame(childRow(CHILD_A, 3, "llm_call"));
    expect(child.chain).toEqual({
      sessionUuid: CHILD_A,
      parentSessionUuid: ROOT_UUID,
      subagentId: "agent-c1",
      subagentType: "Explore",
      spawnToolUseId: "toolu_task_c1",
    });
    expect(frameKey(child)).toBe(`${CHILD_A}:3`);
    const own = tachoFrame(tachoRow(3, "llm_call"));
    expect(own.chain).toBeUndefined();
    expect(frameKey(own)).toBe("3");
    // A root row read by the run-wide reader names the root as its session.
    expect(
      tachoFrame(
        tachoRow(4, "turn_end", {
          sessionUuid: ROOT_UUID,
          rootSessionUuid: ROOT_UUID,
        }),
      ).chain,
    ).toBeUndefined();
    const spawn = tachoFrame(
      tachoRow(5, "subagent_start", {
        toolUseId: "toolu_task_c1",
        attrs: { "hook.agent_id": "agent-c1" },
      }),
    );
    expect(spawn.spawn).toEqual({
      subagentId: "agent-c1",
      toolUseId: "toolu_task_c1",
    });
  });

  it("splices each chain whole after the subagent_start that spawned it, nested chains inside their parent", () => {
    const root = [
      tachoRow(0, "turn_start", { ts: at(0) }),
      tachoRow(1, "tool_requested", {
        ts: at(1),
        toolName: "Task",
        toolUseId: "toolu_task_c1",
      }),
      tachoRow(2, "subagent_start", {
        ts: at(2),
        toolUseId: "toolu_task_c1",
        attrs: { "hook.agent_id": "agent-c1" },
      }),
      // The parent records on while the subagent works.
      tachoRow(3, "oxagen:message", { ts: at(4) }),
      tachoRow(4, "tool_call", {
        ts: at(9),
        toolName: "Task",
        toolUseId: "toolu_task_c1",
      }),
      tachoRow(5, "turn_end", { ts: at(10) }),
    ].map(tachoFrame);
    const children = [
      childRow(CHILD_A, 0, "agent_start", { ts: at(3) }),
      childRow(CHILD_A, 1, "subagent_start", {
        ts: at(5),
        toolUseId: "toolu_task_c3",
      }),
      childRow(CHILD_A, 2, "turn_end", { ts: at(8) }),
      childRow(GRANDCHILD, 0, "llm_call", { ts: at(6) }, CHILD_A),
    ].map(tachoFrame);
    const merged = spliceSubagentChains(root, children);
    expect(merged.map(frameKey)).toEqual([
      "0",
      "1",
      "2",
      `${CHILD_A}:0`,
      `${CHILD_A}:1`,
      `${GRANDCHILD}:0`,
      `${CHILD_A}:2`,
      "3",
      "4",
      "5",
    ]);
    // The parent's Task call still pairs with its own result across the
    // subagent's frames, because pairing keys on the call id.
    const steps = foldTranscript(merged, "steps");
    const task = steps.find(
      (fold) => fold.opening.seq === "1" && !fold.opening.chain,
    );
    expect(task?.request?.seq).toBe("1");
    expect(task?.response?.seq).toBe("4");
    expect(task?.response?.chain).toBeUndefined();
  });

  it("places a chain with no recorded spawn by when it began, and one whose parent is unread under the root (negative: nothing dropped)", () => {
    const root = [
      tachoRow(0, "turn_start", { ts: at(0) }),
      tachoRow(1, "llm_call", { ts: at(5) }),
      tachoRow(2, "turn_end", { ts: at(9) }),
    ].map(tachoFrame);
    const children = [
      childRow(CHILD_A, 0, "agent_start", { ts: at(3) }),
      childRow(CHILD_A, 1, "agent_stop", { ts: at(4) }),
      childRow(CHILD_B, 0, "agent_start", { ts: at(20) }, GRANDCHILD),
    ].map(tachoFrame);
    const merged = spliceSubagentChains(root, children);
    expect(merged.map(frameKey)).toEqual([
      "0",
      `${CHILD_A}:0`,
      `${CHILD_A}:1`,
      "1",
      "2",
      `${CHILD_B}:0`,
    ]);
    expect(spliceSubagentChains(root, [])).toEqual(root);
  });

  it("gives two chains one agent id names to that id's spawns in the order the chains began, whatever the order the store read them in", () => {
    // A subagent resumed under the id it had: two spawns name `agent-r`, and
    // neither recorded the spawning call. The chain that began first answers
    // the first spawn. The later chain is listed first here, as ClickHouse
    // may list it, since it sorts a UUID by its last eight bytes.
    const root = [
      tachoRow(0, "turn_start", { ts: at(0) }),
      tachoRow(1, "subagent_start", {
        ts: at(1),
        attrs: { "hook.agent_id": "agent-r" },
      }),
      tachoRow(2, "turn_start", { ts: at(20) }),
      tachoRow(3, "subagent_start", {
        ts: at(21),
        attrs: { "hook.agent_id": "agent-r" },
      }),
    ].map(tachoFrame);
    const resumed = { subagentId: "agent-r", toolUseId: "" };
    const children = [
      childRow(CHILD_A, 0, "llm_call", { ...resumed, ts: at(22) }),
      childRow(CHILD_B, 0, "llm_call", { ...resumed, ts: at(2) }),
    ].map(tachoFrame);
    const merged = spliceSubagentChains(root, children);
    expect(merged.map(frameKey)).toEqual([
      "0",
      "1",
      `${CHILD_B}:0`,
      "2",
      "3",
      `${CHILD_A}:0`,
    ]);
    expect(turnOrdinals(merged)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("a subagent's own turn_start opens no turn of the run and takes no turn number", () => {
    const root = [
      tachoRow(0, "turn_start", { ts: at(0), turnSeq: 1 }),
      tachoRow(1, "subagent_start", { ts: at(1), toolUseId: "toolu_task_c1" }),
      tachoRow(2, "turn_end", { ts: at(9), turnSeq: 1 }),
      tachoRow(3, "turn_start", { ts: at(10), turnSeq: 2 }),
    ].map(tachoFrame);
    const children = [
      childRow(CHILD_A, 0, "turn_start", { ts: at(2), turnSeq: 1 }),
      childRow(CHILD_A, 1, "llm_call", { ts: at(3), turnSeq: 1 }),
    ].map(tachoFrame);
    const merged = spliceSubagentChains(root, children);
    expect(turnOrdinals(merged)).toEqual([1, 1, 1, 1, 1, 2]);
    const turns = foldTranscript(merged, "turns");
    expect(turns.map((fold) => fold.opening.seq)).toEqual(["0", "3"]);
    expect(turns[0]?.last.seq).toBe("2");
    expect(turns[0]?.frames).toBe(5);
  });
});

describe("one model call reported by several sources", () => {
  const DUP = "oxagen.llm_call_duplicate_of";
  const body = JSON.stringify({
    request_id: "req_1",
    input_tokens: 10,
    output_tokens: 5,
  });
  const retained = (seq: number) => ({
    contentDigest: `sha256:${String(seq).padStart(64, "e")}`,
    bytesRef: `evb:v1:k:${String(seq).padStart(64, "e")}`,
  });

  it("carries no cost on a later sighting (negative: the first sighting keeps its cost)", () => {
    const first = tachoFrame(
      tachoRow(1, "llm_call", {
        body,
        source: "otel_log",
        costUsdMicros: 900,
      }),
    );
    const copy = tachoFrame(
      tachoRow(2, "llm_call", {
        body,
        source: "transcript",
        attrs: { [DUP]: "otel_log" },
        costUsdMicros: 900,
      }),
    );
    expect(first.costMicros).toBe(900);
    expect(first.llmCall).toEqual({
      duplicateOf: null,
      keys: ["request:req_1"],
      source: "otel_log",
    });
    expect(copy.costMicros).toBeNull();
    expect(copy.llmCall?.duplicateOf).toBe("otel_log");
  });

  it("hides a copy with no body, keeps the richer body, and moves the counted spend onto the frame kept", () => {
    // A copy with nothing to read is hidden; the call is one step.
    const proxied = [
      tachoRow(1, "llm_call", {
        body,
        source: "collector",
        costUsdMicros: 700,
        ...retained(1),
      }),
      tachoRow(2, "llm_call", {
        body,
        source: "otel_log",
        attrs: { [DUP]: "collector" },
      }),
      // The transcript's text of the same message: the proxy's stream holds
      // every block of it, so the stream is kept.
      tachoRow(3, "llm_call", {
        body,
        source: "transcript",
        attrs: { [DUP]: "collector" },
        ...retained(3),
      }),
    ].map(tachoFrame);
    expect(withoutDuplicateModelCalls(proxied).map((f) => f.seq)).toEqual([
      "1",
    ]);
    // The first sighting kept no body and the copy did: the copy is shown,
    // with the spend the first sighting carried.
    const otelFirst = [
      tachoRow(1, "llm_call", {
        body,
        source: "otel_log",
        costUsdMicros: 700,
      }),
      tachoRow(2, "llm_call", {
        body,
        source: "transcript",
        attrs: { [DUP]: "otel_log" },
        ...retained(2),
      }),
    ].map(tachoFrame);
    const kept = withoutDuplicateModelCalls(otelFirst);
    expect(kept.map((f) => f.seq)).toEqual(["2"]);
    expect(kept[0]?.costMicros).toBe(700);
    // Two different calls are both kept (negative).
    const two = [
      tachoRow(1, "llm_call", { body, source: "otel_log" }),
      tachoRow(2, "llm_call", {
        body: JSON.stringify({ request_id: "req_2" }),
        source: "transcript",
        attrs: { [DUP]: "otel_log" },
      }),
    ].map(tachoFrame);
    expect(withoutDuplicateModelCalls(two)).toHaveLength(2);
  });

  it("keeps a transcript message's later blocks with its first, and drops them with it", () => {
    // Each later block of one transcript message is stamped a duplicate of
    // `transcript`: it is the rest of the message, not a copy of it.
    const block = (seq: number) =>
      tachoRow(seq, "llm_call", {
        body,
        source: "transcript",
        attrs: { [DUP]: "transcript" },
        ...retained(seq),
      });
    const alone = [
      tachoRow(1, "llm_call", { body, source: "transcript", ...retained(1) }),
      block(2),
      block(3),
    ].map(tachoFrame);
    expect(withoutDuplicateModelCalls(alone).map((f) => f.seq)).toEqual([
      "1",
      "2",
      "3",
    ]);
    // The proxy's stream holds the whole message: the transcript's first
    // block and its later blocks all give way to it.
    const proxied = [
      tachoRow(1, "llm_call", {
        body,
        source: "collector",
        ...retained(1),
      }),
      tachoRow(2, "llm_call", {
        body,
        source: "transcript",
        attrs: { [DUP]: "collector" },
        ...retained(2),
      }),
      block(3),
    ].map(tachoFrame);
    expect(withoutDuplicateModelCalls(proxied).map((f) => f.seq)).toEqual([
      "1",
    ]);
  });
});
