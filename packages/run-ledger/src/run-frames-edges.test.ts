// The edges of the wrapped-frame projection: the label a frame reads as, the
// stage it belongs to, the chain it was recorded on, and bisect over frames
// whose identities differ in each field it keys on.
import { describe, expect, it } from "vitest";
import { bisectFrames, bisectKey, tachoFrame } from "./run-frames";
import { tachoFrameSummary, tachoStage } from "./tacho-kinds";

type Row = Parameters<typeof tachoFrame>[0];

function row(seq: number, kind: string, over: Partial<Row> = {}): Row {
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

describe("tachoStage", () => {
  it("names the stage of every kind the recorder writes", () => {
    const stages = Object.fromEntries(
      [
        "agent_start",
        "subagent_stop",
        "turn_end",
        "llm_call",
        "context.assembled",
        "steering.manifest",
        "tool_requested",
        "harness_permission",
        "token_denied",
        "approval_decision",
        "file_io",
        "network",
        "command",
        "proof.observed",
        "oxagen:message",
        "checkpoint",
      ].map((kind) => [kind, tachoStage(kind)]),
    );
    expect(stages).toEqual({
      agent_start: "session",
      subagent_stop: "session",
      turn_end: "turn",
      llm_call: "model",
      "context.assembled": "model",
      "steering.manifest": "model",
      tool_requested: "tool",
      harness_permission: "tool",
      token_denied: "policy",
      approval_decision: "policy",
      file_io: "effect",
      network: "effect",
      command: "effect",
      "proof.observed": "proof",
      "oxagen:message": "control",
      checkpoint: "chain",
    });
  });
});

describe("tachoFrameSummary", () => {
  it("reads a tool call by its name and status, and falls back to the kind", () => {
    expect(tachoFrameSummary(row(1, "tool_call", { toolName: "Bash" }))).toBe(
      "Bash",
    );
    expect(tachoFrameSummary(row(1, "tool_requested"))).toBe("tool_requested");
  });

  it("reads a model call by provider and model, by model alone, or by its kind", () => {
    expect(
      tachoFrameSummary(
        row(1, "llm_call", { model: "sonnet", provider: "anthropic" }),
      ),
    ).toBe("anthropic/sonnet");
    expect(tachoFrameSummary(row(1, "llm_call", { model: "sonnet" }))).toBe(
      "sonnet",
    );
    expect(tachoFrameSummary(row(1, "llm_call"))).toBe("llm_call");
  });

  it("reads a gate frame by its decision and the call it was about", () => {
    expect(
      tachoFrameSummary(
        row(1, "policy_decision", { policyDecision: "deny", toolName: "Bash" }),
      ),
    ).toBe("deny Bash");
    expect(
      tachoFrameSummary(row(1, "policy_decision", { policyDecision: "allow" })),
    ).toBe("policy allow");
    expect(
      tachoFrameSummary(row(1, "approval_request", { toolName: "Write" })),
    ).toBe("approval_request Write");
    expect(tachoFrameSummary(row(1, "approval_decision"))).toBe(
      "approval_decision",
    );
  });
});

describe("tachoFrame", () => {
  const harnessBody = JSON.stringify({
    tool_name: "Bash",
    tool_use_id: "toolu_1",
    policy_decision: "allow",
    policy_source: "harness",
  });

  it.each(["otel_log", "otel_span"])(
    "reads a stored %s harness check as harness_permission, not a policy decision",
    (source) => {
      const frame = tachoFrame(
        row(4, "policy_decision", {
          source,
          body: harnessBody,
          toolName: "Bash",
          toolUseId: "toolu_1",
          policyDecision: "allow",
        }),
      );
      expect(frame.type).toBe("harness_permission");
      expect(frame.stage).toBe("tool");
      expect(frame.summary).toBe("allow Bash");
      expect(frame.identity.callId).toBe("toolu_1");
    },
  );

  it("keeps a collector verdict as a policy decision and carries its target", () => {
    const frame = tachoFrame(
      row(5, "policy_decision", {
        source: "collector",
        body: JSON.stringify({
          tool_name: "Bash",
          tool_use_id: "toolu_1",
          policy_decision: "allow",
          policy_source: "bundle",
          tool_target: `git fetch origin ${"x".repeat(500)}`,
        }),
        toolName: "Bash",
        toolUseId: "toolu_1",
        policyDecision: "allow",
      }),
    );
    expect(frame.type).toBe("policy_decision");
    expect(frame.stage).toBe("policy");
    expect(frame.identity.target?.startsWith("git fetch origin")).toBe(true);
    expect(frame.identity.target).toHaveLength(400);
  });

  it("keeps a policy decision whose source is not OTel, even when it names the harness", () => {
    const frame = tachoFrame(
      row(6, "policy_decision", { source: "hook", body: harnessBody }),
    );
    expect(frame.type).toBe("policy_decision");
    expect(frame.identity.target).toBeUndefined();
  });

  it("reads redactions that do not parse, or are not a list, as none", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(
      tachoFrame(
        row(1, "tool_call", { contentDigest: digest, redactions: "{" }),
      ).body.redactions,
    ).toEqual([]);
    expect(
      tachoFrame(
        row(1, "tool_call", { contentDigest: digest, redactions: '{"a":1}' }),
      ).body.redactions,
    ).toEqual([]);
  });

  it("names a subagent's chain, and leaves the optional facts null when the row carried none", () => {
    const frame = tachoFrame(
      row(3, "tool_call", {
        sessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000c1",
        rootSessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1",
      }),
    );
    expect(frame.chain).toEqual({
      sessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000c1",
      parentSessionUuid: null,
      subagentId: null,
      subagentType: null,
      spawnToolUseId: null,
    });
  });

  it("names no chain for a frame on the run's own chain", () => {
    const frame = tachoFrame(
      row(3, "tool_call", {
        sessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1",
        rootSessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000a1",
      }),
    );
    expect(frame.chain).toBeUndefined();
  });

  it("reads a spawn's tool call from the body when the column is empty", () => {
    const frame = tachoFrame(
      row(4, "subagent_start", {
        attrs: { "hook.agent_id": "agent-7" },
        body: JSON.stringify({ tool_use_id: "toolu_task" }),
      }),
    );
    expect(frame.spawn).toEqual({
      subagentId: "agent-7",
      toolUseId: "toolu_task",
    });
    const bare = tachoFrame(row(5, "subagent_start"));
    expect(bare.spawn).toEqual({ subagentId: null, toolUseId: null });
  });
});

describe("bisect over wrapped frames", () => {
  const frame = (seq: number, over: Partial<Row>) =>
    tachoFrame(row(seq, over.kind ?? "tool_call", over));

  it("keys on the tool with and without a status, the model and the decision", () => {
    expect(bisectKey(frame(1, { toolName: "Bash", toolStatus: "ok" }))).toBe(
      "tool_call:Bash=ok",
    );
    expect(bisectKey(frame(1, { toolName: "Bash" }))).toBe("tool_call:Bash");
    expect(
      bisectKey(frame(1, { kind: "llm_call", model: "m", provider: "p" })),
    ).toBe("llm_call:p/m");
    expect(
      bisectKey(frame(1, { kind: "policy_decision", policyDecision: "deny" })),
    ).toBe("policy_decision:policy=deny");
  });

  it("reports where two runs part, and which one ran on when they did not", () => {
    const a = [frame(0, { toolName: "Read" }), frame(1, { toolName: "Bash" })];
    const b = [frame(0, { toolName: "Read" })];
    expect(bisectFrames(a, b)).toEqual({
      divergentSeq: "1",
      keyA: "tool_call:Bash",
      keyB: null,
      aligned: 1,
    });
    expect(bisectFrames(b, a)).toEqual({
      divergentSeq: "1",
      keyA: null,
      keyB: "tool_call:Bash",
      aligned: 1,
    });
    expect(bisectFrames(b, b)).toEqual({
      divergentSeq: null,
      keyA: null,
      keyB: null,
      aligned: 1,
    });
    const c = [frame(0, { toolName: "Write" })];
    expect(bisectFrames(b, c).divergentSeq).toBe("0");
  });
});
