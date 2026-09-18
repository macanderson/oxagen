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
  tachoFrame,
  tachoStage,
  tachoTimestamp,
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

  it("steps opens at model and tool calls and folds the rest into the step before", () => {
    const folded = foldTranscript(frames, "steps");
    expect(
      folded.map((f) => [f.opening.seq, f.endSeq, f.kind, f.frames]),
    ).toEqual([
      ["0", "1", "frame", 2],
      ["2", "2", "model_call", 1],
      ["3", "5", "tool_call", 3],
      ["6", "7", "model_call", 2],
    ]);
    expect(folded[1]?.costMicros).toBe(5);
    expect(folded[0]?.costMicros).toBeNull();
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
