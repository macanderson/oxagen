// The Run page's figures over the one step fold (ADR-182). These cases were
// the browser's (apps/app/src/features/run/metrics.test.ts), which counted
// the same figures over its own fold; they are ported so each figure stays
// pinned where it is now counted.
import { describe, expect, it } from "vitest";
import { tachoFrame, type TachoFrameRowLike } from "./run-frames";
import { transcriptFigures } from "./transcript-figures";
import { stepFolds } from "./transcript-steps";

const ROOT = "0192d4a8-7c1e-7a00-8000-00000000000a";
const SUB = "0192d4a8-7c1e-7a00-8000-0000000000c1";

/** A ClickHouse timestamp `second` seconds after 09:00:00. */
function ts(second: number): string {
  const minutes = Math.floor(second / 60);
  const seconds = second % 60;
  return `2026-09-11 09:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000`;
}

/** A wrapped frame on the run's own chain, observed `second` seconds in. */
function w(
  seq: number,
  second: number,
  kind: string,
  over: Partial<TachoFrameRowLike> = {},
) {
  return tachoFrame({
    seq,
    ts: ts(second),
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
  });
}

/** A tool call's one receipt: a whole call in one frame. */
const tool = (seq: number, second: number, name: string, status = "ok") =>
  w(seq, second, "tool_call", {
    toolName: name,
    toolStatus: status,
    toolUseId: `tu_${seq}`,
  });

const figuresOf = (frames: ReturnType<typeof w>[]) =>
  transcriptFigures(frames, stepFolds(frames));

describe("transcriptFigures", () => {
  it("counts the operator's prompts, every one of them", () => {
    const f = figuresOf([
      w(0, 0, "turn_start"),
      w(1, 1, "llm_call", { model: "m" }),
      w(2, 2, "turn_start"),
      w(3, 3, "llm_call", { model: "m" }),
    ]);
    expect(f.prompts).toBe(2);
    expect(f.steps).toEqual({ model: 2, tool: 0 });
  });

  it("counts neither a model request nor a subagent's turn as the operator prompting (negative)", () => {
    // A model request answers the prompt chip, and a subagent's turn opens on
    // words its parent sent. Neither is the operator.
    const f = figuresOf([
      w(0, 0, "turn_start"),
      w(1, 1, "model.request", { model: "m", toolUseId: "m1" }),
      w(2, 2, "model.response", { model: "m", toolUseId: "m1" }),
      tachoFrame({
        seq: 0,
        ts: ts(3),
        kind: "turn_start",
        hash: `sha256:${"c".repeat(64)}`,
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
        sessionUuid: SUB,
        rootSessionUuid: ROOT,
        parentSessionUuid: ROOT,
      }),
    ]);
    expect(f.prompts).toBe(1);
    expect(f.steps.model).toBe(1);
  });

  it("reads the tool calls, their failures, families and batches off the steps", () => {
    const f = figuresOf([
      w(0, 0, "turn_start"),
      w(1, 1, "llm_call", { model: "m" }),
      tool(2, 2, "mcp__github__list_pull_requests"),
      w(3, 3, "llm_call", { model: "m" }),
      tool(4, 4, "mcp__github__create_tag", "error"),
    ]);
    expect(f.calls.count).toBe(2);
    expect(f.calls.failed).toBe(1);
    expect(f.calls.tools).toEqual([
      { name: "mcp__github__create_tag", calls: 1 },
      { name: "mcp__github__list_pull_requests", calls: 1 },
    ]);
    expect(f.calls.families).toEqual([
      { family: "mcp", calls: 2, share: 1, ms: 0, failed: 1, tools: 2 },
    ]);
    expect(f.calls.batches?.count).toBe(2);
  });

  it("counts a parked call's wait as the person's, not the tool's", () => {
    const f = figuresOf([
      w(1, 0, "tool_requested", { toolName: "create_release", toolUseId: "K" }),
      w(2, 1, "approval_request", {
        toolName: "create_release",
        toolUseId: "K",
      }),
      w(3, 601, "approval_decision", {
        toolName: "create_release",
        toolUseId: "K",
        policyDecision: "allow",
      }),
      w(4, 603, "tool_call", {
        toolName: "create_release",
        toolStatus: "ok",
        toolUseId: "K",
      }),
    ]);
    expect(f.calls.count).toBe(1);
    expect(f.wall).toEqual({ modelMs: 0, toolMs: 3_000, waitingMs: 600_000 });
    expect(f.calls.families[0]?.ms).toBe(3_000);
  });

  it("takes a wait off only the call it fell inside", () => {
    const f = figuresOf([
      w(0, 0, "tool_requested", {
        toolName: "list_pull_requests",
        toolUseId: "a",
      }),
      w(1, 2, "tool_call", {
        toolName: "list_pull_requests",
        toolStatus: "ok",
        toolUseId: "a",
      }),
      w(2, 3, "tool_requested", { toolName: "create_release", toolUseId: "b" }),
      w(3, 4, "approval_request", {
        toolName: "create_release",
        toolUseId: "b",
      }),
      w(4, 64, "approval_decision", {
        toolName: "create_release",
        toolUseId: "b",
        policyDecision: "allow",
      }),
      w(5, 65, "tool_call", {
        toolName: "create_release",
        toolStatus: "ok",
        toolUseId: "b",
      }),
    ]);
    // The first call ran 2s and was never parked; the second ran 62s, 60 of
    // them waiting on a person.
    expect(f.calls.batches?.serialMs).toBe(4_000);
    expect(f.wall).toEqual({ modelMs: 0, toolMs: 4_000, waitingMs: 60_000 });
  });

  it("gives a one-frame tool call no time of its own, and sums families and the serial time without it", () => {
    const f = figuresOf([
      w(0, 0, "turn_start"),
      w(1, 1, "llm_call", { model: "m" }),
      // Shell first; the families sort by count, then by name.
      tool(2, 2, "Bash"),
      tool(3, 5, "Read"),
    ]);
    expect(
      f.calls.families.map((family) => [family.family, family.ms]),
    ).toEqual([
      ["read", 0],
      ["shell", 0],
    ]);
    expect(f.calls.families[0]?.share).toBe(0.5);
    expect(f.calls.batches).toEqual({
      count: 1,
      parallel: 1,
      widest: 2,
      fanOut: 2,
      serialMs: 0,
      // From the first call's start to the last call's end: 2s to 5s.
      togetherMs: 3_000,
      histogram: [{ width: 2, batches: 1 }],
    });
  });

  it("counts a failed tool call by its status word and files it under its family's failures", () => {
    const f = figuresOf([
      w(0, 0, "turn_start"),
      w(1, 1, "llm_call", { model: "m" }),
      tool(2, 2, "Bash", "error"),
      tool(3, 3, "Bash"),
    ]);
    expect(f.calls.failed).toBe(1);
    expect(f.calls.families).toEqual([
      { family: "shell", calls: 2, share: 1, ms: 0, failed: 1, tools: 1 },
    ]);
    expect(f.calls.tools).toEqual([{ name: "Bash", calls: 2 }]);
  });

  it("counts a call a rule refused as failed", () => {
    const f = figuresOf([
      w(0, 0, "policy_decision", {
        toolName: "Bash",
        toolUseId: "K",
        policyDecision: "deny",
      }),
      w(1, 1, "tool_requested", { toolName: "Bash", toolUseId: "K" }),
    ]);
    expect(f.calls).toMatchObject({ count: 1, failed: 1 });
  });

  it("closes a batch at a turn boundary even when no model step sits between the calls", () => {
    const f = figuresOf([
      w(0, 0, "turn_start"),
      tool(1, 1, "Bash"),
      w(2, 2, "turn_start"),
      tool(3, 3, "Bash"),
    ]);
    expect(f.calls.batches).toMatchObject({
      count: 2,
      parallel: 0,
      widest: 1,
      fanOut: 1,
      histogram: [{ width: 1, batches: 2 }],
    });
  });

  it("has no batches, no family and no tool for a run that called no tool (negative)", () => {
    const f = figuresOf([w(0, 0, "turn_start"), w(1, 1, "llm_call")]);
    expect(f.calls).toEqual({
      count: 0,
      failed: 0,
      tools: [],
      families: [],
      batches: null,
    });
  });

  it("counts no wait, and no time, for a call still parked at the end of the record", () => {
    // The browser gave this call the 4s to its approval request. The fold
    // says a call with no result has taken no time the record can state, and
    // the figures read the fold.
    const f = figuresOf([
      w(0, 0, "tool_requested", { toolName: "create_release", toolUseId: "K" }),
      w(1, 4, "approval_request", {
        toolName: "create_release",
        toolUseId: "K",
      }),
    ]);
    expect(f.calls.count).toBe(1);
    expect(f.wall).toEqual({ modelMs: 0, toolMs: 0, waitingMs: 0 });
    expect(f.calls.batches?.togetherMs).toBe(0);
  });

  it("times a model step from its request to its response", () => {
    const f = figuresOf([
      w(0, 0, "model.request", { model: "m", toolUseId: "m1" }),
      w(1, 7, "model.response", { model: "m", toolUseId: "m1" }),
    ]);
    expect(f.steps.model).toBe(1);
    expect(f.wall.modelMs).toBe(7_000);
  });

  it("counts a call key sealed twice as one call (#3994)", () => {
    // tool_requested K, tool_requested K, tool_call K, tool_call K: the fold
    // makes one step of the four frames, so the figures count one call.
    const f = figuresOf([
      w(0, 0, "tool_requested", { toolName: "Bash", toolUseId: "K" }),
      w(1, 1, "tool_requested", { toolName: "Bash", toolUseId: "K" }),
      w(2, 2, "tool_call", {
        toolName: "Bash",
        toolStatus: "ok",
        toolUseId: "K",
      }),
      w(3, 3, "tool_call", {
        toolName: "Bash",
        toolStatus: "ok",
        toolUseId: "K",
      }),
    ]);
    expect(f.steps.tool).toBe(1);
    expect(f.calls).toMatchObject({ count: 1, failed: 0 });
    expect(f.wall.toolMs).toBe(3_000);
  });

  it("reads a gateway's prefixed tool name as the tool's own, and lists unnamed calls last", () => {
    const f = figuresOf([
      tool(0, 0, "claude_code__Bash"),
      tool(1, 1, "Bash"),
      w(2, 2, "tool_call", { toolStatus: "ok", toolUseId: "tu_2" }),
    ]);
    expect(f.calls.tools).toEqual([
      { name: "Bash", calls: 2 },
      { name: null, calls: 1 },
    ]);
  });
});
