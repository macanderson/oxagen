import { describe, expect, it } from "vitest";
import { NO_BODY } from "./frame-body";
import {
  bisectFrames,
  bisectKey,
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
import {
  filterFoldsByKind,
  foldTranscript,
  frameFolds,
  stepFolds,
} from "./transcript-steps";
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
    // The in-app turn's steering manifest, as its summary counts it (#4158).
    expect(label("steering.manifest", { included: 3, cut: 0 })).toBe(
      "included=3 cut=0",
    );
    expect(label("steering.manifest", null)).toBe("steering.manifest");
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

  it("reads a call's effort from the proxied request ahead of the harness's report (#3891)", () => {
    const effort = (over: Partial<Parameters<typeof tachoFrame>[0]>) => {
      const { identity } = tachoFrame(tachoRow(20, "llm_call", over));
      return { effort: identity.effort, source: identity.effortSource };
    };
    // The request body the vendor received wins over the context column.
    expect(
      effort({
        effort: "medium",
        body: JSON.stringify({ request_effort: "high" }),
      }),
    ).toEqual({ effort: "high", source: "request" });
    // The harness's report stands where the request named none.
    expect(effort({ effort: "medium", body: "{}" })).toEqual({
      effort: "medium",
      source: "harness",
    });
    // Neither recorded: no effort and no source, never a guessed default.
    expect(effort({ body: JSON.stringify({ request_effort: "  " }) })).toEqual(
      { effort: undefined, source: undefined },
    );
  });

  it("names a decision's rules from the list, falls back to the joined form, and names none otherwise (#3971)", () => {
    const rules = (body: Record<string, unknown> | null) =>
      tachoFrame(
        tachoRow(21, "policy_decision", {
          policyDecision: "allow",
          ...(body === null ? {} : { body: JSON.stringify(body) }),
        }),
      ).identity.rules;
    expect(
      rules({
        policy_rule: "Bash(git add:*) and Bash(git commit:*)",
        policy_rules: ["Bash(git add:*)", "Bash(git commit:*)"],
      }),
    ).toEqual(["Bash(git add:*)", "Bash(git commit:*)"]);
    // A row sealed before the list existed: its joined rule is kept whole,
    // because " and " can sit inside a rule's own pattern.
    expect(rules({ policy_rule: "Bash(echo a and b)" })).toEqual([
      "Bash(echo a and b)",
    ]);
    // An empty list reads as no list, and blanks inside one are dropped.
    expect(rules({ policy_rules: ["", "Read"], policy_rule: "Read" })).toEqual(
      ["Read"],
    );
    expect(rules({ policy_rules: [], policy_rule: "Write" })).toEqual([
      "Write",
    ]);
    expect(rules({})).toBeUndefined();
    expect(rules(null)).toBeUndefined();
    // No producer assesses taint, so no frame carries it.
    expect(
      tachoFrame(tachoRow(22, "policy_decision")).identity.taint,
    ).toBeUndefined();
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

describe("turnOrdinals", () => {
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

  const staged = (
    runSeq: number,
    eventType: string,
    payload: Record<string, unknown> | null = null,
  ) => ledgerFrame(event(runSeq, eventType, payload));

  it("puts the frames that lead up to an indexed model call in that call's turn, and the tools the previous call asked for in the previous one (#3375)", () => {
    const run = [
      staged(1, "admission.run_admitted"),
      staged(2, "model.engine_call_started"),
      staged(3, "model.engine_call_completed"),
      staged(4, "model.call_completed", { turn_index: 0 }),
      staged(5, "tool.engine_call_started"),
      staged(6, "tool.approval_recorded"),
      staged(7, "tool.engine_call_completed"),
      staged(8, "change.recorded"),
      staged(9, "context.history_summarized"),
      staged(10, "steering.manifest"),
      staged(11, "model.engine_call_started"),
      staged(12, "model.engine_call_completed"),
      staged(13, "model.call_completed", { turn_index: 1 }),
      staged(14, "tool.call_completed"),
      staged(15, "terminal.attempt_terminated"),
    ];
    expect(turnOrdinals(run)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2,
    ]);
    // The steps fold reads the same numbering: the second model call's
    // exchange is one step in turn 2, and the tool call before it is in 1.
    const steps = stepFolds(run);
    const at = (seq: string) =>
      steps.find((fold) => fold.opening.seq === seq)?.turn;
    expect(at("5")).toBe(1);
    expect(at("11")).toBe(2);
    // And the turns zoom opens turn 2 on the context the call was handed.
    expect(
      foldTranscript(run, "turns").map((fold) => [fold.key, fold.endSeq]),
    ).toEqual([
      ["1", "8"],
      ["9", "15"],
    ]);
  });

  it("carries a model call's lead-in back only as far as the previous call's last tool frame (#3375)", () => {
    const run = [
      staged(1, "model.call_completed", { turn_index: 0 }),
      staged(2, "context.frames_selected"),
      staged(3, "tool.call_completed"),
      staged(4, "context.frames_selected"),
      staged(5, "model.call_completed", { turn_index: 1 }),
    ];
    expect(turnOrdinals(run)).toEqual([1, 1, 1, 2, 2]);
    // An indexed call straight after another carries nothing back.
    expect(
      turnOrdinals([
        staged(1, "model.call_completed", { turn_index: 0 }),
        staged(2, "model.call_completed", { turn_index: 1 }),
      ]),
    ).toEqual([1, 2]);
    // Frames before the first indexed call stay in the first turn.
    expect(
      turnOrdinals([
        staged(1, "context.frames_selected"),
        staged(2, "model.engine_call_started"),
        staged(3, "model.call_completed", { turn_index: 4 }),
      ]),
    ).toEqual([1, 1, 1]);
  });

  it("leaves a wrapped run's unindexed model frame in the turn before it, where ClickHouse counts it", () => {
    const wrapped = [
      tachoFrame(tachoRow(0, "llm_call", { turnSeq: 1 })),
      tachoFrame(tachoRow(1, "context.assembled")),
      tachoFrame(tachoRow(2, "llm_call")),
      tachoFrame(tachoRow(3, "llm_call", { turnSeq: 2 })),
    ];
    expect(turnOrdinals(wrapped)).toEqual([1, 1, 1, 2]);
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

  it("reads a parked call as parked, naming its approval, and not as an error", () => {
    const parked = ledgerFrame(
      event(2, "tool.engine_call_completed", {
        tool_call_id: "tc_1",
        tool_name: "create_workspace",
        outcome: "parked",
        approval_public_id: "apr_0a1b2c3d4e5f6g7h8j9k0m",
        input_digest: `sha256:${"b".repeat(64)}`,
        error_digest: `sha256:${"c".repeat(64)}`,
        duration_ms: 4,
      }),
    );
    // The approval is a field of the frame, never a word of its label: a
    // client pairs on the field and has nothing to parse (ADR-182 rule 3).
    expect(parked.summary).toBe("create_workspace parked");
    expect(parked.summary).not.toContain("apr_");
    expect(parked.identity.approvalId).toBe("apr_0a1b2c3d4e5f6g7h8j9k0m");
    expect(parked.identity.toolStatus).toBe("parked");
    // Waiting on a person is not a failure: the errors chip leaves it out.
    expect(frameKinds(parked)).toContain("tools");
    expect(frameKinds(parked)).not.toContain("errors");
    // A parked receipt that names no approval reads as the other outcomes do.
    const unnamed = ledgerFrame(
      event(3, "tool.engine_call_completed", {
        tool_call_id: "tc_2",
        tool_name: "create_workspace",
        outcome: "parked",
        input_digest: `sha256:${"b".repeat(64)}`,
        duration_ms: 4,
      }),
    );
    expect(unnamed.summary).toBe("create_workspace parked");
    expect(unnamed.identity.approvalId).toBeUndefined();
    // A denied call is still an error, and names no approval.
    const denied = ledgerFrame(
      event(4, "tool.engine_call_completed", {
        tool_call_id: "tc_3",
        tool_name: "create_workspace",
        outcome: "denied",
        input_digest: `sha256:${"b".repeat(64)}`,
        duration_ms: 4,
      }),
    );
    expect(denied.summary).toBe("create_workspace denied");
    expect(frameKinds(denied)).toContain("errors");
  });
});

describe("frameKinds and the chips an entry answers", () => {
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
    tachoRow(3, "llm_call", {
      model: "m",
      costUsdMicros: 9,
      contentDigest: `sha256:${"d".repeat(64)}`,
      bytesRef: "evidence://stream",
    }),
  );
  const policy = tachoFrame(
    tachoRow(4, "policy_decision", { policyDecision: "deny" }),
  );
  const recall = ledgerFrame(
    event(5, "context.frames_selected", { frame_count: 3 }),
  );

  it("derives every chip a frame answers to", () => {
    // The request half of a model call is the context the model was sent,
    // not a prompt a person typed, so it answers no chip (ADR-182).
    expect(frameKinds(model)).toEqual([]);
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
      filterFoldsByKind(frameFolds([ok, rejected]), ["errors"]).map(
        (f) => f.opening.seq,
      ),
    ).toEqual(["12"]);
  });

  it("files a history summary under recall and names what it stands in for (#4171)", () => {
    const summary = ledgerFrame(
      event(9, "context.history_summarized", {
        provider: "conversation_history",
        outcome: "applied",
        covered_message_count: 80,
        window_message_count: 40,
        regenerated: true,
      }),
    );
    expect(frameKinds(summary)).toEqual(["recall"]);
    expect(summary.summary).toBe("history summary applied (80)");
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
      filterFoldsByKind(frameFolds([typed, handed, copy, tool]), [
        "prompt",
      ]).map((f) => f.opening.seq),
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
    // The seal chip is the run's own stop, which the Transcript tab draws.
    // A checkpoint and a gap are the chain's, and read on the Chain tab.
    const stopped = tachoFrame(tachoRow(14, "agent_stop"));
    const subagentStopped = tachoFrame(
      tachoRow(15, "agent_stop", {
        sessionUuid: "sub",
        rootSessionUuid: "root",
      }),
    );
    expect(frameKinds(checkpoint)).toEqual([]);
    expect(frameKinds(gap)).toEqual([]);
    expect(frameKinds(terminated)).toEqual(["seal"]);
    expect(frameKinds(stopped)).toEqual(["seal"]);
    expect(frameKinds(subagentStopped)).toEqual([]);
    expect(frameKinds(tool)).not.toContain("seal");
  });

  it("answers responses for a reply whose words were kept, and usage for tokens without a cost", () => {
    const kept = {
      contentDigest: `sha256:${"c".repeat(64)}`,
      bytesRef: "evidence://reply",
    };
    const reply = tachoFrame(tachoRow(16, "turn_end", kept));
    const unkept = tachoFrame(tachoRow(17, "turn_end"));
    expect(frameKinds(reply)).toEqual(["responses"]);
    expect(frameKinds(unkept)).toEqual([]);
    const counted = {
      ...model,
      usage: {
        inputUncached: 10,
        cacheRead: null,
        cacheWrite: null,
        output: 4,
        reasoning: null,
      },
    };
    expect(frameKinds(counted)).toEqual(["usage"]);
  });

  // Finding P2 of the ADR-182 re-review: every model response answered
  // `responses`, so a response kept as a digest alone counted under a chip
  // that draws nothing for it. What it carried still answers `usage`, which
  // draws its usage row, and the effort a call ran at is on that row too.
  it("answers responses only for a model response whose body was kept (negative)", () => {
    const digestOnly = tachoFrame(
      tachoRow(18, "llm_call", {
        model: "m",
        costUsdMicros: 9,
        contentDigest: `sha256:${"e".repeat(64)}`,
      }),
    );
    const bare = tachoFrame(tachoRow(19, "llm_call", { model: "m" }));
    const effort = tachoFrame(
      tachoRow(20, "llm_call", { model: "m", effort: "high" }),
    );
    expect(frameKinds(digestOnly)).toEqual(["usage"]);
    expect(frameKinds(bare)).toEqual([]);
    expect(frameKinds(effort)).toEqual(["usage"]);
    // Effort is a model call's; a tool frame that named one answers no usage.
    const toolEffort = tachoFrame(
      tachoRow(21, "tool_call", { toolName: "Read", effort: "high" }),
    );
    expect(frameKinds(toolEffort)).toEqual(["tools"]);
  });

  it("keeps everything for an empty selection, and only the chips pressed otherwise", () => {
    const folds = frameFolds([model, tool, usage, policy, recall]);
    const seqs = (kept: typeof folds) => kept.map((f) => f.opening.seq);
    expect(filterFoldsByKind(folds, [])).toHaveLength(5);
    expect(seqs(filterFoldsByKind(folds, ["errors"]))).toEqual(["2"]);
    expect(seqs(filterFoldsByKind(folds, ["responses", "recall"]))).toEqual([
      "3",
      "5",
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
    // How the call ended, which the fold reads for the errors chip.
    expect(modelFrame.identity.toolStatus).toBe("completed");
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
      partial: false,
    });
    expect(copy.costMicros).toBeNull();
    expect(copy.llmCall?.duplicateOf).toBe("otel_log");
  });

  it("marks a body the proxy kept one half of", () => {
    const half = tachoFrame(
      tachoRow(1, "llm_call", {
        body,
        source: "collector",
        attrs: { "oxagen.response_body_omitted": "too_large" },
      }),
    );
    expect(half.llmCall?.partial).toBe(true);
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
