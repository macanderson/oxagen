// The transcript's grouping, digests and transport arithmetic, without a render.
import { describe, expect, it } from "vitest";
import type { TranscriptBody } from "@/data/contracts/run";
import type { TranscriptEntry } from "@/data/contracts/run";
import {
  mockupTranscript,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";
import {
  buildTranscript,
  decisionSubject,
  entryKey,
  type Frames,
  frameAt,
  frameCost,
  idsAt,
  isNonEmpty,
  openAtZoom,
  playDelay,
  stepDigest,
  stepModel,
  stepTool,
  type TranscriptStep,
  toolExchange,
  visibleChildren,
  visibleFrames,
  visibleSteps,
} from "./transcript-model";

const { entries } = mockupTranscript();
const turns = buildTranscript(entries);

/** The step at `s` in turn `t`; a missing one fails the test that asked. */
function step(t: number, s: number) {
  const found = turns[t]?.steps[s];
  if (found === undefined)
    throw new Error(`no step ${String(s)} in turn ${String(t)}`);
  return found;
}

describe("buildTranscript", () => {
  it("groups the frames before the first turn into the run's start, then one group per turn", () => {
    expect(turns.map((t) => [t.id, t.turn, t.frames.length])).toEqual([
      ["t0", null, 2],
      ["t2", 1, 7],
      ["t9", 2, 4],
    ]);
  });

  it("pairs a model request with its response and a tool request with its decision and call", () => {
    expect(turns[1]?.steps.map((s) => [s.id, s.kind, s.from, s.to])).toEqual([
      ["s2", "event", 2, 2],
      ["s3", "model", 3, 4],
      ["s5", "tool", 5, 7],
      ["s8", "event", 8, 8],
    ]);
    expect(turns[2]?.steps.map((s) => [s.id, s.kind])).toEqual([
      ["s9", "event"],
      ["s10", "model"],
      ["s11", "tool"],
    ]);
  });

  it("takes the prompt from turn_start and the reply from turn_end, and leaves both null when no body was kept", () => {
    expect(turns[1]?.prompt).toBe("Cut the 2026.9.2 release candidate.");
    expect(turns[1]?.reply).toBe("Both failures predate the release scope.");
    expect(turns[2]?.prompt).toBeNull();
    expect(turns[2]?.reply).toBeNull();
  });

  it("is empty for no entries, and one group for a run with no turns", () => {
    expect(buildTranscript([])).toEqual([]);
    const flat = buildTranscript([
      transcriptEntry({ seq: "1", turn: null }),
      transcriptEntry({ seq: "2", turn: null }),
    ]);
    expect(flat).toHaveLength(1);
  });

  it("reads the reply from the agent's reported message when the turn closed without one", () => {
    // Cursor reports the agent's message apart from `stop`. When `stop`
    // lands first, the turn_end carries no body and the message frame is
    // the only copy of the reply.
    const cursor = buildTranscript([
      transcriptEntry({
        seq: "1",
        type: "turn_start",
        kind: "frame",
        turn: 1,
        request: transcriptBody({ seq: "1", text: "Fix the build." }),
        response: null,
      }),
      transcriptEntry({
        seq: "2",
        type: "turn_end",
        kind: "frame",
        turn: 1,
        request: null,
        response: null,
      }),
      transcriptEntry({
        seq: "3",
        type: "oxagen:message",
        kind: "frame",
        turn: 1,
        request: null,
        response: transcriptBody({ seq: "3", text: "The build is fixed." }),
      }),
    ]);
    expect(cursor[0]?.prompt).toBe("Fix the build.");
    expect(cursor[0]?.reply).toBe("The build is fixed.");
  });

  it("leaves the prompt null rather than guessing when turn_start carries both halves (negative)", () => {
    // soleBody (module-private) is what `prompt`/`reply` read a body through:
    // an entry carrying both halves refuses rather than picking one, so a
    // turn_start folded with a result still reads as no recorded prompt
    // instead of silently showing the wrong half.
    const folded = buildTranscript([
      transcriptEntry({
        seq: "1",
        type: "turn_start",
        turn: 1,
        request: transcriptBody({ seq: "1", text: "Cut the release." }),
        response: transcriptBody({ seq: "1", text: "Cutting it now." }),
      }),
    ]);
    expect(folded[0]?.prompt).toBeNull();
  });

  it("pairs the in-app assistant's engine_call halves into one model step and one tool step", () => {
    // The Run page reads at `everything`, where each half is its own entry
    // with kind model_call / tool_call. Without pairing on the engine types,
    // a normal started/completed exchange draws as two spine steps.
    const turns = buildTranscript([
      transcriptEntry({
        seq: "1",
        type: "model.engine_call_started",
        kind: "model_call",
        label: "anthropic/claude-fable-5-1",
        turn: 1,
        request: transcriptBody({
          seq: "1",
          type: "model.engine_call_started",
        }),
        response: null,
        frames: 1,
      }),
      transcriptEntry({
        seq: "2",
        type: "model.engine_call_completed",
        kind: "model_call",
        label: "anthropic/claude-fable-5-1",
        turn: 1,
        request: null,
        response: transcriptBody({
          seq: "2",
          type: "model.engine_call_completed",
          text: "I will list the open pull requests first.",
        }),
        frames: 1,
        cost: { micros: "380000", currency: "USD", basis: "gateway_observed" },
      }),
      transcriptEntry({
        seq: "3",
        type: "tool.engine_call_started",
        kind: "tool_call",
        label: "list_pull_requests",
        turn: 1,
        request: transcriptBody({ seq: "3", type: "tool.engine_call_started" }),
        response: null,
        frames: 1,
        cost: null,
      }),
      transcriptEntry({
        seq: "4",
        type: "tool.approval_recorded",
        kind: "frame",
        label: "policy allow",
        turn: 1,
        request: null,
        response: null,
        frames: 1,
        cost: null,
        decision: {
          seq: "4",
          decision: "allow",
          type: "tool.approval_recorded",
          at: "2026-09-15T08:00:08.000Z",
        },
      }),
      transcriptEntry({
        seq: "5",
        type: "tool.engine_call_completed",
        kind: "tool_call",
        label: "list_pull_requests completed",
        turn: 1,
        request: null,
        response: transcriptBody({
          seq: "5",
          type: "tool.engine_call_completed",
          text: '{"open":34}',
        }),
        frames: 1,
        cost: null,
      }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.steps.map((s) => [s.id, s.kind, s.from, s.to])).toEqual([
      ["s1", "model", 0, 1],
      ["s3", "tool", 2, 4],
    ]);
    const model = turns[0]?.steps[0];
    const tool = turns[0]?.steps[1];
    // Narrowed by a throw rather than asserted: the app bans type assertions,
    // and a missing step should fail here, naming what was missing, rather
    // than inside stepDigest.
    if (model === undefined || tool === undefined) {
      throw new Error(
        "expected the turn to carry a model step and a tool step",
      );
    }
    const modelDigest = stepDigest(model);
    expect(modelDigest).toMatchObject({
      node: "model",
      name: "claude-fable-5-1",
    });
    // typeof rather than expect.any(Number), which is typed `any` and is used
    // nowhere else in apps/app.
    expect(typeof modelDigest.durationMs).toBe("number");
    expect(stepDigest(tool)).toMatchObject({
      node: "tool",
      name: "list_pull_requests",
      status: "completed",
    });
  });

  it("leaves an unmatched engine_call_started as its own step (negative)", () => {
    const turns = buildTranscript([
      transcriptEntry({
        seq: "1",
        type: "model.engine_call_started",
        kind: "model_call",
        label: "anthropic/claude-fable-5-1",
        turn: 1,
        request: transcriptBody({
          seq: "1",
          type: "model.engine_call_started",
        }),
        response: null,
        frames: 1,
      }),
      transcriptEntry({
        seq: "2",
        type: "turn_end",
        kind: "frame",
        label: "turn_end",
        turn: 1,
        frames: 1,
      }),
    ]);
    expect(turns[0]?.steps.map((s) => [s.id, s.kind])).toEqual([
      ["s1", "model"],
      ["s2", "event"],
    ]);
  });

  it("pairs overlapping tool calls by call key, not by adjacency", () => {
    // start A, start B, complete A, complete B: adjacency would end A at B,
    // then pair B with A's completion, and leave B's result as its own step.
    // With matching call keys each step owns its own start and complete.
    const turns = buildTranscript([
      transcriptEntry({
        seq: "1",
        type: "tool.engine_call_started",
        kind: "tool_call",
        label: "read_file",
        callKey: "tc_a",
        turn: 1,
        request: transcriptBody({
          seq: "1",
          type: "tool.engine_call_started",
          text: '{"path":"a.ts"}',
        }),
        response: null,
        frames: 1,
        cost: null,
      }),
      transcriptEntry({
        seq: "2",
        type: "tool.engine_call_started",
        kind: "tool_call",
        label: "read_file",
        callKey: "tc_b",
        turn: 1,
        request: transcriptBody({
          seq: "2",
          type: "tool.engine_call_started",
          text: '{"path":"b.ts"}',
        }),
        response: null,
        frames: 1,
        cost: null,
      }),
      transcriptEntry({
        seq: "3",
        type: "tool.engine_call_completed",
        kind: "tool_call",
        label: "read_file completed",
        callKey: "tc_a",
        turn: 1,
        request: null,
        response: transcriptBody({
          seq: "3",
          type: "tool.engine_call_completed",
          text: "contents of a",
        }),
        frames: 1,
        cost: null,
      }),
      transcriptEntry({
        seq: "4",
        type: "tool.engine_call_completed",
        kind: "tool_call",
        label: "read_file completed",
        callKey: "tc_b",
        turn: 1,
        request: null,
        response: transcriptBody({
          seq: "4",
          type: "tool.engine_call_completed",
          text: "contents of b",
        }),
        frames: 1,
        cost: null,
      }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.steps.map((s) => [s.id, s.kind, s.from, s.to])).toEqual([
      ["s1", "tool", 0, 2],
      ["s2", "tool", 1, 3],
    ]);
    const stepA = turns[0]?.steps[0];
    const stepB = turns[0]?.steps[1];
    if (stepA === undefined || stepB === undefined) {
      throw new Error("expected two tool steps for the overlapping calls");
    }
    expect(stepA.frames.map((f) => f.seq)).toEqual(["1", "3"]);
    expect(stepB.frames.map((f) => f.seq)).toEqual(["2", "4"]);
    expect(stepA.frames[1]?.response?.text).toBe("contents of a");
    expect(stepB.frames[1]?.response?.text).toBe("contents of b");
  });
});

describe("stepDigest", () => {
  it("names a model step by its model, with its wall time and cost", () => {
    const d = stepDigest(step(1, 1));
    expect(d).toMatchObject({
      node: "model",
      name: "claude-fable-5-1",
      arg: "anthropic/claude-fable-5-1",
      durationMs: 2000,
      cost: { micros: "380000", currency: "USD" },
    });
  });

  it("names a tool step by its tool, with the policy's outcome and the call's status", () => {
    expect(stepDigest(step(1, 2))).toMatchObject({
      node: "tool",
      name: "list_pull_requests",
      arg: null,
      outcome: "allow",
      status: "ok",
      durationMs: 4000,
      cost: null,
    });
  });

  it("marks a tool step the policy denied (negative)", () => {
    expect(stepDigest(step(2, 2))).toMatchObject({
      node: "deny",
      name: "create_tag",
      outcome: "deny",
      status: null,
    });
  });

  it("draws the agent's start and a turn's boundaries as control, and any other frame as neutral", () => {
    expect(stepDigest(step(0, 0)).node).toBe("control");
    expect(stepDigest(step(0, 1))).toMatchObject({
      node: "tool",
      name: "context.assembled",
      arg: null,
      durationMs: null,
    });
    expect(stepDigest(step(1, 0)).node).toBe("control");
  });
});

describe("the transport", () => {
  // The prefix sum and the clock are the read's, not the page's:
  // `get_run_transcript` measures both from the run's start, so a transcript
  // that was cut short still reports what the run had spent by a frame. These
  // replace the page-local `costAt` and `elapsedAt` the view used to compute.
  it("carries the run's cumulative cost, and none before the first cost record", () => {
    expect(entries[3]?.cumulativeCost).toBeNull();
    expect(entries[4]?.cumulativeCost?.micros).toBe("380000");
    expect(entries[12]?.cumulativeCost?.micros).toBe("900000");
  });

  it("carries elapsed time measured from the run's start", () => {
    expect(entries[0]?.elapsedMs).toBe(0);
    expect(entries[12]?.elapsedMs).toBe(24_000);
  });

  it("paces playback on the recorded gap, held between 120 ms and 2 s and divided by the speed", () => {
    expect(playDelay(entries, 0, 1)).toBe(2000);
    expect(playDelay(entries, 0, 2)).toBe(1000);
    const burst = [
      transcriptEntry({ seq: "1", at: "2026-09-15T08:00:00.000Z" }),
      transcriptEntry({ seq: "2", at: "2026-09-15T08:00:00.010Z" }),
    ];
    expect(playDelay(burst, 0, 1)).toBe(120);
    expect(playDelay(burst, 1, 1)).toBe(400);
  });

  it("opens nothing at Turns, the turns at Steps, and turns and steps at Everything", () => {
    expect(openAtZoom(turns, "turns").size).toBe(0);
    expect([...openAtZoom(turns, "steps")]).toEqual(["t0", "t2", "t9"]);
    expect(openAtZoom(turns, "everything").has("s5")).toBe(true);
  });

  it("finds the turn and step holding a position", () => {
    expect(idsAt(turns, 6)).toEqual(["t2", "s5"]);
    expect(idsAt(turns, 99)).toEqual([]);
  });
});

describe("effect frames fold into the call they belong to", () => {
  // The recorder writes `command`, `file_io` and `network` as their own
  // frames beside the `tool_call` they describe, so a Bash call used to draw
  // two rows: `Bash`, then a `command` row with no body under it.
  const tool = (over: Partial<TranscriptEntry> = {}) =>
    transcriptEntry({
      kind: "tool_call",
      type: "tool_call",
      label: "Bash",
      turn: 1,
      ...over,
    });
  const effect = (over: Partial<TranscriptEntry> = {}) =>
    transcriptEntry({
      kind: "tool_call",
      type: "command",
      label: "command",
      turn: 1,
      ...over,
    });

  it("draws one step for a call and its effect frame", () => {
    const steps = buildTranscript([
      tool({ seq: "1", callKey: "toolu_a" }),
      effect({ seq: "2", callKey: "toolu_a" }),
    ])[0]?.steps;
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.kind).toBe("tool");
    // Nothing is dropped: the folded frame is still evidence under the step.
    expect(steps?.[0]?.frames).toHaveLength(2);
  });

  it("folds a request, its call and its effect frame into one step", () => {
    const steps = buildTranscript([
      transcriptEntry({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
        callKey: "toolu_a",
        turn: 1,
      }),
      tool({ seq: "2", callKey: "toolu_a" }),
      effect({ seq: "3", callKey: "toolu_a" }),
    ])[0]?.steps;
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.frames).toHaveLength(3);
  });

  it("folds every effect frame a call wrote, not only the first", () => {
    const steps = buildTranscript([
      tool({ seq: "1", callKey: "toolu_a" }),
      effect({ seq: "2", callKey: "toolu_a" }),
      effect({
        seq: "3",
        type: "file_io",
        label: "file_io",
        callKey: "toolu_a",
      }),
    ])[0]?.steps;
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.frames).toHaveLength(3);
  });

  it("leaves an effect frame that names a different call as its own step", () => {
    // Two calls in flight. Folding by adjacency alone would put B's effect
    // under A, which is a claim the record does not support.
    const steps = buildTranscript([
      tool({ seq: "1", callKey: "toolu_a" }),
      effect({ seq: "2", callKey: "toolu_b" }),
    ])[0]?.steps;
    expect(steps).toHaveLength(2);
  });

  it("falls back to adjacency only when neither side recorded a key", () => {
    const steps = buildTranscript([
      tool({ seq: "1", callKey: null }),
      effect({ seq: "2", callKey: null }),
    ])[0]?.steps;
    expect(steps).toHaveLength(1);
  });

  it("stops at the next call rather than swallow it", () => {
    const steps = buildTranscript([
      tool({ seq: "1", callKey: "toolu_a" }),
      effect({ seq: "2", callKey: "toolu_a" }),
      tool({ seq: "3", label: "Read", callKey: "toolu_b" }),
    ])[0]?.steps;
    expect(steps).toHaveLength(2);
    expect(steps?.[1]?.frames).toHaveLength(1);
  });
});

describe("stepDigest on a gate frame", () => {
  const gate = (label: string, type = "policy_decision") => {
    const frame = transcriptEntry({
      seq: "1",
      kind: "policy",
      type,
      label,
      turn: 1,
      cost: null,
      cumulativeCost: null,
    });
    return stepDigest({
      id: "g1",
      kind: "event",
      from: 1,
      to: 1,
      first: frame,
      last: frame,
      frames: [frame],
    });
  };

  it("says what was decided, and on which call", () => {
    const digest = gate("deny Bash");
    expect(digest.name).toBe("deny");
    expect(digest.arg).toBe("Bash");
    // The name already is the decision, so an outcome chip beside it would
    // say the same word twice.
    expect(digest.outcome).toBeNull();
  });

  it("says the decision alone when the record named no call", () => {
    const digest = gate("policy allow");
    expect(digest.name).toBe("allow");
    expect(digest.arg).toBeNull();
  });

  it("reads an approval the same way", () => {
    expect(gate("allow Write", "approval_decision").name).toBe("allow");
    expect(gate("allow Write", "approval_decision").arg).toBe("Write");
  });
});

describe("repeated bookkeeping frames", () => {
  const bare = (seq: number, type = "oxagen:hook_health") =>
    transcriptEntry({
      seq: String(seq),
      endSeq: String(seq),
      kind: "frame",
      type,
      label: type,
      request: null,
      response: null,
      decision: null,
      frames: 1,
      turn: 1,
      cost: null,
      cumulativeCost: null,
      kinds: [],
    });

  it("folds a run of the same frame with nothing on it into one step with a count", () => {
    // Claude Code registers its hooks one frame at a time at a session's
    // start; thirty identical rows before the prompt is what the page drew.
    const frames = [
      bare(0, "agent_start"),
      bare(1),
      bare(2),
      bare(3),
      bare(4, "oxagen:mcp_connection"),
      bare(5, "oxagen:mcp_connection"),
      transcriptEntry({ seq: "6", endSeq: "6", turn: 1 }),
      bare(7),
    ];
    const [turn] = buildTranscript(frames);
    expect(turn?.steps.map((s) => [s.id, s.kind, s.from, s.to])).toEqual([
      ["s0", "event", 0, 0],
      ["s1", "event", 1, 3],
      ["s4", "event", 4, 5],
      ["s6", "model", 6, 6],
      ["s7", "event", 7, 7],
    ]);
    const folded = turn?.steps[1];
    if (folded === undefined) throw new Error("expected the folded step");
    expect(stepDigest(folded).repeats).toBe(3);
    expect(stepDigest(folded).name).toBe("oxagen:hook_health");
    // A single frame and a step of another kind carry no count (negative).
    expect(stepDigest(turn?.steps[0] ?? folded).repeats).toBeNull();
    expect(stepDigest(turn?.steps[3] ?? folded).repeats).toBeNull();
  });

  it("does not fold a frame that carries a half or a decision (negative)", () => {
    const frames = [
      bare(0),
      transcriptEntry({
        seq: "1",
        endSeq: "1",
        kind: "frame",
        type: "oxagen:hook_health",
        label: "oxagen:hook_health",
        request: null,
        response: transcriptBody({ seq: "1", type: "oxagen:hook_health" }),
        decision: null,
        turn: 1,
      }),
      bare(2),
    ];
    const [turn] = buildTranscript(frames);
    expect(turn?.steps.map((s) => [s.id, s.from, s.to])).toEqual([
      ["s0", 0, 0],
      ["s1", 1, 1],
      ["s2", 2, 2],
    ]);
  });
});

describe("toolExchange", () => {
  it("reads a wrapped tool receipt apart into its input and its output", () => {
    const body = JSON.stringify({
      input: { command: "ls", description: "List" },
      output: { stdout: "a\nb\n", stderr: "", interrupted: false },
    });
    expect(toolExchange(body)).toEqual({
      input: '{\n  "command": "ls",\n  "description": "List"\n}',
      output: "a\nb\n",
    });
  });

  it("keeps a non-stream output as JSON and a string as itself", () => {
    expect(
      toolExchange(JSON.stringify({ input: "x", output: { file: { n: 1 } } })),
    ).toEqual({ input: "x", output: '{\n  "file": {\n    "n": 1\n  }\n}' });
  });

  it("is null for a body that is not the receipt shape (negative)", () => {
    expect(toolExchange("not json")).toBeNull();
    expect(toolExchange('{"path":"README.md"}')).toBeNull();
    expect(toolExchange("[1,2]")).toBeNull();
  });
});

describe("a tool call sealed by three sources", () => {
  const call = "toolu_01dupe";
  const digestOnly = (seq: number) =>
    transcriptEntry({
      seq: String(seq),
      endSeq: String(seq),
      kind: "tool_call",
      type: "tool_call",
      label: "Read ok",
      callKey: call,
      kinds: ["tools"],
      request: null,
      response: transcriptBody({
        seq: String(seq),
        type: "tool_call",
        fidelity: "digest_only",
        bytesRef: null,
        text: null,
      }),
      turn: 1,
      cost: null,
      cumulativeCost: null,
    });
  const frames = [
    transcriptEntry({
      seq: "0",
      endSeq: "0",
      kind: "tool_call",
      type: "tool_requested",
      label: "Read",
      callKey: call,
      kinds: ["tools"],
      request: transcriptBody({ seq: "0", type: "tool_requested", text: "{}" }),
      response: null,
      turn: 1,
      cost: null,
      cumulativeCost: null,
    }),
    transcriptEntry({
      seq: "1",
      endSeq: "1",
      kind: "tool_call",
      type: "tool_call",
      label: "Read ok",
      callKey: call,
      kinds: ["tools"],
      request: null,
      response: transcriptBody({
        seq: "1",
        type: "tool_call",
        text: '{"input":{},"output":"x"}',
      }),
      turn: 1,
      cost: null,
      cumulativeCost: null,
    }),
    transcriptEntry({ seq: "2", endSeq: "2", turn: 1 }),
    digestOnly(3),
    digestOnly(4),
  ];

  it("folds the hook, OTel and transcript copies into one step on the call id", () => {
    const [turn] = buildTranscript(frames);
    expect(turn?.steps.map((s) => [s.id, s.kind, s.frames.length])).toEqual([
      ["s0", "tool", 4],
      ["s2", "model", 1],
    ]);
  });

  it("draws only the copy that carries the body", () => {
    const [turn] = buildTranscript(frames);
    const step = turn?.steps[0];
    if (step === undefined) throw new Error("expected the tool step");
    expect(visibleFrames(step).map((f) => f.seq)).toEqual(["0", "1"]);
    // Every copy digest-only: nothing to prefer, so every copy stays (negative).
    const bare = buildTranscript([digestOnly(0), digestOnly(1)])[0]?.steps[0];
    if (bare === undefined) throw new Error("expected the bare step");
    expect(visibleFrames(bare).map((f) => f.seq)).toEqual(["0", "1"]);
  });

  it("does not fold a call with no call id, or a different one (negative)", () => {
    const other = { ...digestOnly(3), callKey: "toolu_other" };
    const none = { ...digestOnly(4), callKey: null };
    const [requested, called] = frames;
    if (requested === undefined || called === undefined)
      throw new Error("expected the request and the call");
    const [turn] = buildTranscript([requested, called, other, none]);
    expect(turn?.steps.map((s) => s.id)).toEqual(["s0", "s3", "s4"]);
  });
});

describe("a model step reads as what it did", () => {
  const reply = (blocks: NonNullable<TranscriptBody["blocks"]>) =>
    transcriptEntry({
      seq: "3",
      endSeq: "3",
      kind: "model_call",
      type: "llm_call",
      label: "anthropic/claude-opus-5",
      request: null,
      response: transcriptBody({
        seq: "3",
        type: "llm_call",
        text: null,
        blocks,
      }),
      turn: 1,
    });

  it("names the tool the reply called, with the command's first line, and keeps the model as a chip", () => {
    const [turn] = buildTranscript([
      reply([
        { kind: "text", text: "Checking the tree." },
        {
          kind: "tool_use",
          name: "Bash",
          input: {
            command: "git status --short\ngit log -3",
            description: "Tree",
          },
          callKey: "toolu_1",
        },
        {
          kind: "tool_use",
          name: "Read",
          input: { file_path: "/repo/README.md" },
          callKey: "toolu_2",
        },
      ]),
    ]);
    const step = turn?.steps[0];
    if (step === undefined) throw new Error("expected the model step");
    const detail = stepModel(step);
    expect(detail?.name).toBe("Bash");
    expect(detail?.group).toBe("shell");
    expect(detail?.headline).toBe("git status --short");
    expect(detail?.multiline).toBe(true);
    expect(detail?.detail).toBe("+1");
    expect(detail?.panes.map((pane) => pane.label)).toEqual(["command"]);
    expect(stepDigest(step).name).toBe("claude-opus-5");
  });

  it("reads a reply with no call as a reply, first line first", () => {
    const [turn] = buildTranscript([
      reply([{ kind: "text", text: "Done.\nThe pager reaches every run." }]),
    ]);
    const step = turn?.steps[0];
    if (step === undefined) throw new Error("expected the model step");
    const detail = stepModel(step);
    expect(detail?.name).toBe("reply");
    expect(detail?.headline).toBe("Done.");
    expect(detail?.multiline).toBe(true);
    expect(detail?.panes).toEqual([
      {
        kind: "note",
        label: "reply",
        text: "Done.\nThe pager reaches every run.",
      },
    ]);
  });

  it("is null without blocks, and for a tool step (negative)", () => {
    const [turn] = buildTranscript([
      transcriptEntry({ seq: "3", endSeq: "3", turn: 1 }),
      transcriptEntry({
        seq: "4",
        endSeq: "4",
        kind: "tool_call",
        type: "tool_call",
        label: "Read ok",
        turn: 1,
      }),
    ]);
    const [plain, tool] = turn?.steps ?? [];
    if (plain === undefined || tool === undefined)
      throw new Error("expected a model step and a tool step");
    expect(stepModel(plain)).toBeNull();
    expect(stepModel(tool)).toBeNull();
  });
});

describe("visibleSteps", () => {
  it("drops steps with nothing to read and keeps decisions and bodies", () => {
    const bare = (seq: number, type: string) =>
      transcriptEntry({
        seq: String(seq),
        endSeq: String(seq),
        kind: "frame",
        type,
        label: type,
        request: null,
        response: null,
        decision: null,
        turn: 1,
        cost: null,
        cumulativeCost: null,
        kinds: [],
      });
    const [turn] = buildTranscript([
      bare(0, "oxagen:hook_health"),
      bare(1, "oxagen:hook_health"),
      transcriptEntry({ seq: "2", endSeq: "2", turn: 1 }),
      transcriptEntry({
        seq: "3",
        endSeq: "3",
        kind: "policy",
        type: "policy_decision",
        label: "policy deny",
        request: null,
        response: null,
        decision: {
          seq: "3",
          decision: "deny",
          type: "policy_decision",
          at: transcriptEntry().at,
        },
        turn: 1,
      }),
      transcriptEntry({
        seq: "4",
        endSeq: "4",
        kind: "model_call",
        type: "llm_call",
        request: null,
        response: transcriptBody({
          seq: "4",
          fidelity: "digest_only",
          bytesRef: null,
          text: null,
        }),
        turn: 1,
      }),
    ]);
    if (turn === undefined) throw new Error("expected a turn");
    expect(turn.steps.map((s) => s.id)).toEqual(["s0", "s2", "s3", "s4"]);
    expect(visibleSteps(turn).map((s) => s.id)).toEqual(["s2", "s3"]);
  });
});

describe("a subagent's entries in the run's transcript", () => {
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
  const sub = { chainRef: CHAIN, type: "Explore" };

  it("names each entry by chain and seq, so a subagent's seq 2 is not the run's", () => {
    const own = transcriptEntry({ seq: "2", turn: 1 });
    const theirs = transcriptEntry({ seq: "2", turn: 1, subagent: sub });
    expect(entryKey(own)).toBe("2");
    expect(entryKey(theirs)).toBe(`${CHAIN}:2`);
    const [turn] = buildTranscript([own, theirs]);
    const ids = turn?.steps.map((s) => s.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads the turn's prompt and reply from the run's own frames, not the subagent's", () => {
    const [turn] = buildTranscript([
      transcriptEntry({
        seq: "1",
        type: "turn_start",
        kind: "frame",
        turn: 1,
        request: transcriptBody({ seq: "1", text: "Find the flaky test." }),
        response: null,
      }),
      transcriptEntry({
        seq: "0",
        type: "turn_start",
        kind: "frame",
        turn: 1,
        subagent: sub,
        request: transcriptBody({ seq: "0", text: "Search the test tree." }),
        response: null,
      }),
      transcriptEntry({
        seq: "3",
        type: "turn_end",
        kind: "frame",
        turn: 1,
        subagent: sub,
        request: null,
        response: transcriptBody({ seq: "3", text: "Three candidates." }),
      }),
      transcriptEntry({
        seq: "5",
        type: "turn_end",
        kind: "frame",
        turn: 1,
        request: null,
        response: null,
      }),
    ]);
    expect(turn?.prompt).toBe("Find the flaky test.");
    // The run's turn_end kept no reply; the subagent's is not the run's.
    expect(turn?.reply).toBeNull();
  });
});

// ── Edges of the grouping and the readers ────────────────────────────────────
//
// Every frame below is built from `frame()`, which starts from nothing: no
// halves, no decision, no cost and no call key. Each test names the fields its
// case depends on, so what a test exercises is readable at the call site
// rather than inherited from the builder's model-call defaults.

const T0 = "2026-09-15T08:00:00.000Z";

function frame(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return transcriptEntry({
    kind: "frame",
    type: "oxagen:note",
    label: "oxagen:note",
    at: T0,
    callKey: null,
    request: null,
    response: null,
    decision: null,
    turn: 1,
    frames: 1,
    cost: null,
    cumulativeCost: null,
    kinds: [],
    ...over,
  });
}

/** A body carrying `text`; `null` stands for a digest-only seal. */
function body(seq: string, text: string | null): TranscriptBody {
  return transcriptBody(
    text === null
      ? { seq, fidelity: "digest_only", bytesRef: null, text: null }
      : { seq, text },
  );
}

/** The steps of a transcript recorded in one turn. */
function stepsIn(entries: readonly TranscriptEntry[]): TranscriptStep[] {
  const built = buildTranscript(entries);
  const [turn] = built;
  if (turn === undefined || built.length !== 1)
    throw new Error(`expected one turn, got ${String(built.length)}`);
  return turn.steps;
}

/** The step at `n`; a missing one fails the test that asked, by name. */
function nth(steps: readonly TranscriptStep[], n: number): TranscriptStep {
  const found = steps[n];
  if (found === undefined) throw new Error(`no step ${String(n)}`);
  return found;
}

/** Each step as its id and the seqs of the frames it owns. */
function shape(steps: readonly TranscriptStep[]): [string, string[]][] {
  return steps.map((s) => [s.id, s.frames.map((f) => f.seq)]);
}

/** A hand-built step over `frames`, for the readers that take one. */
function stepOver(
  kind: TranscriptStep["kind"],
  frames: Frames,
): TranscriptStep {
  const [first] = frames;
  const last = frames[frames.length - 1] ?? first;
  return {
    id: `s${first.seq}`,
    kind,
    from: 0,
    to: frames.length - 1,
    first,
    last,
    frames: [...frames],
  };
}

describe("frameAt and isNonEmpty", () => {
  it("holds a position inside the transcript at both ends", () => {
    expect(isNonEmpty([])).toBe(false);
    if (!isNonEmpty(entries)) throw new Error("expected the mockup's frames");
    expect(frameAt(entries, -4).seq).toBe(entries[0].seq);
    expect(frameAt(entries, 3).seq).toBe(entries[3]?.seq);
    expect(frameAt(entries, 10_000).seq).toBe(entries[entries.length - 1]?.seq);
  });
});

describe("buildTranscript: turns, prompts and replies", () => {
  it("keeps a turn number reused after a gap as its own group, in recorded order", () => {
    const built = buildTranscript([
      frame({ seq: "1", turn: 1 }),
      frame({ seq: "2", turn: 2 }),
      frame({ seq: "3", turn: 1 }),
    ]);
    expect(built.map((t) => [t.id, t.turn])).toEqual([
      ["t1", 1],
      ["t2", 2],
      ["t3", 1],
    ]);
    // Positions stay the transcript's own, not the group's.
    expect(built[2]?.steps.map((s) => [s.from, s.to])).toEqual([[2, 2]]);
  });

  it("reads the prompt from the first turn_start that kept text, skipping a digest-only one", () => {
    const [turn] = buildTranscript([
      frame({ seq: "1", type: "turn_start", request: body("1", null) }),
      frame({ seq: "2", type: "turn_start", request: body("2", "Ship it.") }),
    ]);
    expect(turn?.prompt).toBe("Ship it.");
  });

  it("reads the reply from the last turn_end that kept text, and prefers it to a message frame", () => {
    const [turn] = buildTranscript([
      frame({ seq: "1", type: "turn_end", response: body("1", "Early.") }),
      frame({ seq: "2", type: "oxagen:message", response: body("2", "Said.") }),
      frame({ seq: "3", type: "turn_end", response: body("3", "Final.") }),
    ]);
    expect(turn?.reply).toBe("Final.");
  });

  it("leaves the reply null when neither a turn_end nor a message kept text (negative)", () => {
    const [turn] = buildTranscript([
      frame({ seq: "1", type: "turn_end", response: body("1", null) }),
      frame({ seq: "2", type: "oxagen:message", response: body("2", null) }),
    ]);
    expect(turn?.prompt).toBeNull();
    expect(turn?.reply).toBeNull();
  });
});

describe("pairing a model call's halves", () => {
  it("pairs a keyed request with its response by key, across another frame of the same call", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "model_call",
        type: "model.request",
        label: "anthropic/claude-opus-5",
        callKey: "m1",
      }),
      frame({ seq: "2", type: "oxagen:stream_tick", callKey: "m1" }),
      frame({
        seq: "3",
        kind: "model_call",
        type: "model.response",
        label: "anthropic/claude-opus-5",
        callKey: "m1",
      }),
    ]);
    expect(shape(steps)).toEqual([
      ["s1", ["1", "3"]],
      ["s2", ["2"]],
    ]);
    expect(nth(steps, 0)).toMatchObject({ kind: "model", from: 0, to: 2 });
  });

  it("pairs a keyed engine call with its receipt, not with a wrapped response of the same key", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "model_call",
        type: "model.engine_call_started",
        label: "m",
        callKey: "m1",
      }),
      frame({
        seq: "2",
        kind: "model_call",
        type: "model.response",
        label: "m",
        callKey: "m1",
      }),
      frame({
        seq: "3",
        kind: "model_call",
        type: "model.engine_call_completed",
        label: "m",
        callKey: "m1",
      }),
    ]);
    expect(shape(steps)).toEqual([
      ["s1", ["1", "3"]],
      ["s2", ["2"]],
    ]);
  });

  it("leaves a keyed request whose response never came as a one-frame step (negative)", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "model_call",
        type: "model.request",
        label: "m",
        callKey: "m1",
      }),
      frame({
        seq: "2",
        kind: "model_call",
        type: "model.response",
        label: "m",
        callKey: "m2",
      }),
    ]);
    expect(shape(steps)).toEqual([
      ["s1", ["1"]],
      ["s2", ["2"]],
    ]);
    expect(stepDigest(nth(steps, 0)).durationMs).toBeNull();
  });

  it("does not pair an unkeyed request with a response that is not next to it (negative)", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "model_call",
        type: "model.request",
        label: "m",
      }),
      frame({ seq: "2", type: "oxagen:stream_tick" }),
      frame({
        seq: "3",
        kind: "model_call",
        type: "model.response",
        label: "m",
      }),
    ]);
    expect(steps.map((s) => [s.id, s.kind])).toEqual([
      ["s1", "model"],
      ["s2", "event"],
      ["s3", "model"],
    ]);
  });
});

describe("pairing a tool call's halves", () => {
  it("leaves a keyed request whose call never came as a one-frame tool step", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Read",
        callKey: "t1",
      }),
    ]);
    expect(shape(steps)).toEqual([["s1", ["1"]]]);
    // With no call frame the request names the tool, and nothing recorded a status.
    expect(stepDigest(nth(steps, 0))).toMatchObject({
      node: "tool",
      name: "Read",
      arg: null,
      outcome: null,
      status: null,
      durationMs: null,
    });
  });

  it("ends an unkeyed request at the first frame that is neither a gate nor its call (negative)", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
      }),
      frame({
        seq: "2",
        kind: "policy",
        type: "policy_decision",
        label: "allow Bash",
      }),
      frame({ seq: "3", kind: "model_call", type: "llm_call", label: "m" }),
      frame({
        seq: "4",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
      }),
    ]);
    expect(shape(steps)).toEqual([
      ["s1", ["1", "2"]],
      ["s3", ["3"]],
      ["s4", ["4"]],
    ]);
  });

  it("does not fold a keyed effect frame into a call that recorded no key (negative)", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
      }),
      frame({
        seq: "2",
        type: "command",
        label: "command",
        callKey: "toolu_x",
      }),
    ]);
    expect(shape(steps)).toEqual([
      ["s1", ["1"]],
      ["s2", ["2"]],
    ]);
  });
});

describe("toolExchange on the shapes it refuses and the streams it reads", () => {
  it("is null for JSON that is not an object carrying both halves (negative)", () => {
    expect(toolExchange("null")).toBeNull();
    expect(toolExchange("42")).toBeNull();
    expect(toolExchange('"text"')).toBeNull();
    expect(toolExchange('{"input":{"command":"ls"}}')).toBeNull();
  });

  const outputOf = (output: unknown) =>
    toolExchange(JSON.stringify({ input: "x", output }))?.output;

  it("joins stdout and stderr, and reads either alone when the other is empty", () => {
    expect(outputOf({ stdout: "built", stderr: "1 warning" })).toBe(
      "built\n1 warning",
    );
    expect(outputOf({ stdout: "", stderr: "boom" })).toBe("boom");
    expect(outputOf({ stdout: "done" })).toBe("done");
  });

  it("prints the JSON when the streams hold nothing to read (negative)", () => {
    expect(outputOf({ stdout: "", stderr: "" })).toBe(
      '{\n  "stdout": "",\n  "stderr": ""\n}',
    );
    expect(outputOf({ stdout: 7 })).toBe('{\n  "stdout": 7\n}');
    expect(outputOf(["a"])).toBe('[\n  "a"\n]');
    expect(outputOf(null)).toBe("null");
  });
});

describe("decisionSubject", () => {
  it("names the call a gate decided on, and nothing when the gate named none", () => {
    expect(
      decisionSubject(
        frame({ kind: "policy", type: "policy_decision", label: "deny Bash" }),
      ),
    ).toBe("Bash");
    expect(
      decisionSubject(
        frame({
          kind: "policy",
          type: "policy_decision",
          label: "policy deny",
        }),
      ),
    ).toBeNull();
    expect(
      decisionSubject(
        frame({
          kind: "policy",
          type: "approval_request",
          label: "approval_request",
        }),
      ),
    ).toBeNull();
  });

  it("names a tool frame by its own tool, for each spelling of a call", () => {
    expect(
      decisionSubject(
        frame({ kind: "tool_call", type: "tool_call", label: "Bash ok" }),
      ),
    ).toBe("Bash");
    expect(
      decisionSubject(
        frame({ kind: "tool_call", type: "tool_requested", label: "Read" }),
      ),
    ).toBe("Read");
    expect(
      decisionSubject(
        frame({
          kind: "tool_call",
          type: "tool.engine_call_completed",
          label: "list_pull_requests completed",
        }),
      ),
    ).toBe("list_pull_requests");
  });

  it("claims no subject for a tool frame whose label is only its type, or a frame that is no call (negative)", () => {
    expect(
      decisionSubject(
        frame({ kind: "tool_call", type: "tool_call", label: "tool_call" }),
      ),
    ).toBeNull();
    expect(
      decisionSubject(
        frame({
          kind: "model_call",
          type: "llm_call",
          label: "anthropic/claude-opus-5",
        }),
      ),
    ).toBeNull();
    expect(
      decisionSubject(frame({ type: "turn_start", label: "turn_start" })),
    ).toBeNull();
  });
});

describe("stepDigest edges", () => {
  it("names a model step by its whole label when the label carries no provider", () => {
    const d = stepDigest(
      stepOver("model", [
        frame({ kind: "model_call", type: "llm_call", label: "claude-opus-5" }),
      ]),
    );
    expect(d).toMatchObject({
      node: "model",
      name: "claude-opus-5",
      arg: null,
      durationMs: null,
    });
  });

  it("marks a tool step whose call failed or timed out as a denial, with the status it recorded", () => {
    for (const status of ["error", "failed", "timeout"]) {
      const d = stepDigest(
        stepOver("tool", [
          frame({
            kind: "tool_call",
            type: "tool_call",
            label: `Bash ${status}`,
          }),
        ]),
      );
      expect(d).toMatchObject({
        node: "deny",
        name: "Bash",
        status,
        outcome: null,
      });
    }
    // A status outside the failure words is not a denial (negative).
    expect(
      stepDigest(
        stepOver("tool", [
          frame({ kind: "tool_call", type: "tool_call", label: "Bash ok" }),
        ]),
      ).node,
    ).toBe("tool");
  });

  it("reads a tool step's gate from the folded decision before its label, and times it end to end", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
        at: T0,
      }),
      frame({
        seq: "2",
        kind: "policy",
        type: "policy_decision",
        label: "policy_decision",
        decision: {
          seq: "2",
          decision: "reject",
          type: "policy_decision",
          at: T0,
        },
      }),
      frame({
        seq: "3",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash",
        at: "2026-09-15T08:00:01.500Z",
      }),
    ]);
    expect(stepDigest(nth(steps, 0))).toMatchObject({
      node: "deny",
      name: "Bash",
      arg: null,
      outcome: "reject",
      status: null,
      durationMs: 1500,
    });
  });

  it("keeps the request's label as the argument when it says more than the tool's name", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Read src/app.ts",
      }),
      frame({
        seq: "2",
        kind: "tool_call",
        type: "tool_call",
        label: "Read ok",
      }),
    ]);
    expect(stepDigest(nth(steps, 0))).toMatchObject({
      name: "Read",
      arg: "Read src/app.ts",
      status: "ok",
    });
  });

  const gateStep = (over: Partial<TranscriptEntry>) =>
    stepDigest(
      stepOver("event", [
        frame({ kind: "policy", type: "policy_decision", ...over }),
      ]),
    );

  it("names a gate that recorded no decision by its type, never by a word it did not record", () => {
    // The label is the frame's own type: no decision in it.
    expect(gateStep({ label: "policy_decision" })).toMatchObject({
      node: "policy",
      name: "policy_decision",
      arg: null,
    });
    // `policy` with no second word decided nothing either.
    expect(gateStep({ label: "policy" })).toMatchObject({
      node: "policy",
      name: "policy_decision",
      arg: null,
    });
    // One word that is neither: not read as a decision without a call after it.
    expect(
      gateStep({ type: "approval_decision", label: "deny" }),
    ).toMatchObject({
      node: "policy",
      name: "approval_decision",
      arg: null,
    });
  });

  it("names a gate by the folded decision when its label carries none", () => {
    const decided = (decision: string) =>
      gateStep({
        type: "approval_request",
        label: "approval_request",
        decision: { seq: "1", decision, type: "approval_request", at: T0 },
      });
    expect(decided("allow")).toMatchObject({
      node: "policy",
      name: "allow",
      outcome: null,
    });
    expect(decided("denied")).toMatchObject({
      node: "deny",
      name: "denied",
      outcome: null,
    });
  });

  it("draws admission and oxagen frames as control, and keeps a label that says more than the type", () => {
    const event = (type: string, label: string) =>
      stepDigest(stepOver("event", [frame({ type, label })]));
    expect(event("admission.checked", "admission.checked")).toMatchObject({
      node: "control",
      arg: null,
    });
    expect(event("oxagen:hook_health", "hook PreToolUse")).toMatchObject({
      node: "control",
      name: "oxagen:hook_health",
      arg: "hook PreToolUse",
      outcome: null,
    });
    expect(event("context.assembled", "3 files")).toMatchObject({
      node: "tool",
      arg: "3 files",
    });
  });
});

describe("stepTool", () => {
  it("is null for a step that is not a tool call (negative)", () => {
    expect(
      stepTool(
        stepOver("model", [frame({ kind: "model_call", type: "llm_call" })]),
      ),
    ).toBeNull();
  });

  it("reads the call's receipt before the request, which holds the input alone", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
        request: body("1", '{"command":"ls"}'),
      }),
      frame({
        seq: "2",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
        response: body("2", '{"input":{"command":"ls -la"},"output":"a.ts"}'),
      }),
    ]);
    expect(stepTool(nth(steps, 0))).toMatchObject({
      name: "Bash",
      group: "shell",
      headline: "ls -la",
    });
  });

  it("falls back to the request's input when the call never completed", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
        request: body("1", '{"command":"pwd"}'),
      }),
    ]);
    expect(stepTool(nth(steps, 0))).toMatchObject({
      name: "Bash",
      headline: "pwd",
    });
  });

  it("takes the tool's name from the body when the label is only the frame's type", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_call",
        label: "tool_call",
        response: body(
          "1",
          '{"tool_use":{"name":"Read","input":{"file_path":"src/app.ts"}}}',
        ),
      }),
    ]);
    expect(stepTool(nth(steps, 0))).toMatchObject({
      name: "Read",
      group: "read",
      headline: "src/app.ts",
    });
  });

  it("still names the tool from its label when every copy was digest-only", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_call",
        label: "Grep ok",
        response: body("1", null),
      }),
    ]);
    expect(stepTool(nth(steps, 0))).toMatchObject({
      name: "Grep",
      headline: null,
      panes: [],
    });
  });

  it("is null when neither the label nor a body names the tool (negative)", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_call",
        label: "tool_call",
        response: body("1", null),
      }),
    ]);
    expect(stepTool(nth(steps, 0))).toBeNull();
  });
});

describe("stepModel edges", () => {
  const withBlocks = (
    half: "request" | "response",
    blocks: NonNullable<TranscriptBody["blocks"]>,
  ) =>
    stepOver("model", [
      frame({
        kind: "model_call",
        type: "llm_call",
        label: "anthropic/claude-opus-5",
        [half]: transcriptBody({ seq: "1", text: null, blocks }),
      }),
    ]);

  it("reads the blocks from whichever half kept them, and a one-line reply is not multiline", () => {
    expect(
      stepModel(withBlocks("request", [{ kind: "text", text: "Done." }])),
    ).toMatchObject({
      name: "reply",
      headline: "Done.",
      multiline: false,
    });
  });

  it("keeps a single call's own detail rather than a count", () => {
    const detail = stepModel(
      withBlocks("response", [
        {
          kind: "tool_use",
          name: "Read",
          input: { file_path: "a.ts", offset: 9, limit: 10 },
          callKey: "t1",
        },
      ]),
    );
    expect(detail).toMatchObject({
      name: "Read",
      headline: "a.ts",
      detail: "lines 10–19",
    });
  });

  it("is null when the blocks hold only thinking, or are empty (negative)", () => {
    expect(
      stepModel(withBlocks("response", [{ kind: "thinking", text: "Hmm." }])),
    ).toBeNull();
    expect(stepModel(withBlocks("response", []))).toBeNull();
  });
});

describe("visibleSteps and visibleFrames edges", () => {
  it("keeps a gate that recorded no decision and no body, and a step whose request alone has text", () => {
    const [turn] = buildTranscript([
      frame({
        seq: "1",
        kind: "policy",
        type: "policy_decision",
        label: "policy_decision",
      }),
      frame({ seq: "2", type: "oxagen:note", request: body("2", "kept") }),
      frame({ seq: "3", type: "oxagen:tick" }),
    ]);
    if (turn === undefined) throw new Error("expected a turn");
    expect(visibleSteps(turn).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("returns a model step's frames as they are", () => {
    const step = stepOver("model", [
      frame({
        seq: "1",
        kind: "model_call",
        type: "model.request",
        response: body("1", null),
      }),
      frame({
        seq: "2",
        kind: "model_call",
        type: "model.response",
        response: body("2", null),
      }),
    ]);
    expect(visibleFrames(step).map((f) => f.seq)).toEqual(["1", "2"]);
  });

  it("drops a digest-only copy of the call but keeps its gate, its effect frame and an unkeyed request", () => {
    const steps = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
        request: body("1", null),
      }),
      frame({
        seq: "2",
        kind: "policy",
        type: "policy_decision",
        label: "allow Bash",
      }),
      frame({
        seq: "3",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
        callKey: "toolu_k",
        response: body("3", '{"input":{},"output":"ok"}'),
      }),
    ]);
    expect(shape(steps)).toEqual([["s1", ["1", "2", "3"]]]);
    expect(visibleFrames(nth(steps, 0)).map((f) => f.seq)).toEqual([
      "1",
      "2",
      "3",
    ]);

    const keyed = stepsIn([
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
        callKey: "toolu_k",
        response: body("1", '{"input":{},"output":"ok"}'),
      }),
      frame({
        seq: "2",
        type: "command",
        label: "command",
        callKey: "toolu_k",
      }),
      frame({
        seq: "3",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
        callKey: "toolu_k",
        response: body("3", null),
      }),
    ]);
    expect(shape(keyed)).toEqual([["s1", ["1", "2", "3"]]]);
    expect(visibleFrames(nth(keyed, 0)).map((f) => f.seq)).toEqual(["1", "2"]);
  });

  it("keeps a digest-only copy when no copy of that same call carries the body (negative)", () => {
    // The body of call A is no reason to hide call B's only copy.
    const step = stepOver("tool", [
      frame({
        seq: "1",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
        callKey: "toolu_a",
        response: body("1", '{"input":{},"output":"ok"}'),
      }),
      frame({
        seq: "2",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
        callKey: "toolu_b",
        response: body("2", null),
      }),
    ]);
    expect(visibleFrames(step).map((f) => f.seq)).toEqual(["1", "2"]);
  });
});

describe("frameCost", () => {
  const usd = (micros: string): TranscriptEntry["cost"] => ({
    micros,
    currency: "USD",
    basis: "gateway_observed",
  });

  it("is null when no frame carried a cost, rather than a zero (negative)", () => {
    expect(frameCost([])).toBeNull();
    expect(frameCost([frame(), frame()])).toBeNull();
  });

  it("sums the frames that carried one and skips the ones that did not", () => {
    expect(
      frameCost([
        frame({ cost: usd("380000") }),
        frame(),
        frame({ cost: usd("120000") }),
      ]),
    ).toEqual({
      micros: "500000",
      currency: "USD",
    });
  });

  it("refuses a total across currencies (negative)", () => {
    expect(
      frameCost([
        frame({ cost: usd("1") }),
        frame({ cost: { micros: "1", currency: "EUR", basis: null } }),
      ]),
    ).toBeNull();
  });
});

// ── A wrapped Claude Code session ────────────────────────────────────────────
//
// The shape of run bcfb444f: Oxagen's gate decides each call, Claude Code's
// own permission check writes a `harness_permission` frame for the same call,
// and the call's receipt lands later, often with other calls' frames between.
// Each group below shares one `tool_use_id`.

describe("a wrapped Claude Code session", () => {
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c2";
  const gate = (seq: string, key: string, target: string | null) =>
    frame({
      seq,
      kind: "policy",
      type: "policy_decision",
      label: "allow Bash",
      callKey: key,
      target,
      decision: { seq, decision: "allow", type: "policy_decision", at: T0 },
    });
  const harness = (seq: string, key: string | null, verdict = "allow") =>
    frame({
      seq,
      type: "harness_permission",
      label: `${verdict} Bash`,
      callKey: key,
    });
  const call = (
    seq: string,
    key: string,
    label: string,
    response: TranscriptBody | null = body(seq, null),
    over: Partial<TranscriptEntry> = {},
  ) =>
    frame({
      seq,
      kind: "tool_call",
      type: "tool_call",
      label,
      callKey: key,
      response,
      ...over,
    });
  const sub = { chainRef: CHAIN, type: "Explore", spawnKey: "toolu_C" };

  const entries = [
    frame({
      seq: "1",
      type: "turn_start",
      request: body("1", "Fetch main and find the flaky test."),
    }),
    gate("2", "toolu_A", "git fetch origin main"),
    gate("3", "toolu_B", "git status"),
    harness("4", "toolu_A"),
    harness("5", "toolu_B"),
    call("6", "toolu_A", "Bash ok"),
    call(
      "7",
      "toolu_B",
      "Bash ok",
      body(
        "7",
        JSON.stringify({
          name: "Bash",
          input: { command: "git status" },
          output: { stdout: "nothing to commit" },
        }),
      ),
    ),
    gate("8", "toolu_C", null),
    harness("9", "toolu_C"),
    frame({ seq: "10", type: "subagent_start", callKey: "toolu_C" }),
    call("0", "toolu_X1", "Grep ok", body("0", null), { subagent: sub }),
    call("1", "toolu_X2", "Read ok", body("1", null), { subagent: sub }),
    call("11", "toolu_C", "Task ok"),
    harness("12", "toolu_D", "deny"),
    harness("13", "toolu_E"),
  ];
  const steps = stepsIn(entries);
  const turn = buildTranscript(entries)[0];
  if (turn === undefined) throw new Error("expected a turn");
  const shown = visibleSteps(turn);

  it("draws one step per call, not one row per permission check", () => {
    const tools = shown.filter((s) => s.kind === "tool");
    expect(tools.map((s) => stepDigest(s).name)).toEqual([
      "Bash",
      "Bash",
      "Task",
    ]);
    expect(tools[0]?.frames.map((f) => f.seq)).toEqual(["2", "4", "6"]);
    expect(tools[1]?.frames.map((f) => f.seq)).toEqual(["3", "5", "7"]);
  });

  it("shows the command the gate recorded when the call kept no body", () => {
    const fetch = shown.find((s) => s.first.callKey === "toolu_A");
    if (fetch === undefined) throw new Error("expected the fetch");
    expect(stepDigest(fetch)).toMatchObject({
      node: "tool",
      arg: "git fetch origin main",
    });
    const detail = stepTool(fetch);
    expect(detail?.headline).toBe("git fetch origin main");
    expect(detail?.panes).toEqual([
      expect.objectContaining({
        kind: "code",
        label: "command",
        text: "git fetch origin main",
      }),
    ]);
  });

  it("shows the command and its output when the call kept its body", () => {
    const status = shown.find((s) => s.first.callKey === "toolu_B");
    if (status === undefined) throw new Error("expected the status");
    const detail = stepTool(status);
    expect(detail?.headline).toBe("git status");
    expect(detail?.panes.map((p) => p.label)).toEqual(["command", "output"]);
    // The harness's allow says nothing the call does not; the frames list
    // keeps the gate and the receipt.
    expect(visibleFrames(status).map((f) => f.type)).toEqual([
      "policy_decision",
      "tool_call",
    ]);
  });

  it("nests the subagent's calls under the Task call that spawned it", () => {
    const task = shown.find((s) => s.first.callKey === "toolu_C");
    if (task === undefined) throw new Error("expected the Task call");
    expect(task.frames.map((f) => f.type)).toContain("subagent_start");
    expect(visibleChildren(task).map((s) => stepDigest(s).name)).toEqual([
      "Grep",
      "Read",
    ]);
    expect(steps.some((s) => s.first.subagent !== undefined)).toBe(false);
    const child = visibleChildren(task)[0];
    if (child === undefined) throw new Error("expected a child");
    expect(idsAt([turn], child.from)).toEqual([turn.id, task.id, child.id]);
    expect(openAtZoom([turn], "everything").has(child.id)).toBe(true);
  });

  it("shows a harness refusal and hides a harness allow with nothing else", () => {
    const refused = shown.find((s) => s.first.callKey === "toolu_D");
    expect(refused).toBeDefined();
    expect(shown.some((s) => s.first.callKey === "toolu_E")).toBe(false);
    expect(
      shown.filter((s) => s.first.type === "harness_permission"),
    ).toHaveLength(1);
  });
});
