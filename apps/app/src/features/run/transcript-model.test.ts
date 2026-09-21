// The transcript's grouping, digests and transport arithmetic, without a render.
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/data/contracts/run";
import {
  mockupTranscript,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";
import {
  buildTranscript,
  idsAt,
  openAtZoom,
  playDelay,
  stepDigest,
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
      effect({ seq: "3", type: "file_io", label: "file_io", callKey: "toolu_a" }),
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
