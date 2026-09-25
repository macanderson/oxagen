// The transcript's grouping and digests, and the feed the Transcript tab
// draws from them, without a render.
import { describe, expect, it } from "vitest";
import type { TranscriptBody, TranscriptEntry } from "@/data/contracts/run";
import {
  mockupTranscript,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";
import { releaseTranscript } from "./transcript.builders";
import {
  buildFeed,
  buildTranscript,
  decisionSubject,
  entryKey,
  type FeedRow,
  flatSteps,
  frameCost,
  type Frames,
  isOperatorPrompt,
  mergeEntries,
  stepDigest,
  stepTool,
  type TranscriptStep,
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

  it("is empty for no entries, and one group for a run with no turns", () => {
    expect(buildTranscript([])).toEqual([]);
    const flat = buildTranscript([
      transcriptEntry({ seq: "1", turn: null }),
      transcriptEntry({ seq: "2", turn: null }),
    ]);
    expect(flat).toHaveLength(1);
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

  it("reads the copy that carries the body, passing over the digest-only ones", () => {
    const [turn] = buildTranscript(frames);
    const step = turn?.steps[0];
    if (step === undefined) throw new Error("expected the tool step");
    expect(stepTool(step)?.output).toBe("x");
    // Every copy digest-only: the label still names the tool, and nothing
    // is read out of a body that was not kept (negative).
    const bare = buildTranscript([digestOnly(0), digestOnly(1)])[0]?.steps[0];
    if (bare === undefined) throw new Error("expected the bare step");
    expect(stepTool(bare)).toMatchObject({ name: "Read", output: null });
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
});

describe("mergeEntries", () => {
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
  const sub = { chainRef: CHAIN, type: "Explore" };
  const entry = (seq: string, over: Partial<TranscriptEntry> = {}) =>
    transcriptEntry({ seq, endSeq: seq, frames: 1, ...over });

  it("replaces an entry a page sends again where it stands, and appends the new ones in order", () => {
    const held = [entry("1"), entry("2"), entry("3")] as const;
    const grown = entry("2", { endSeq: "7", frames: 4, label: "Task ok" });
    const merged = mergeEntries(held, [grown, entry("8"), entry("9")]);
    expect(merged.map((e) => [e.seq, e.endSeq])).toEqual([
      ["1", "1"],
      ["2", "7"],
      ["3", "3"],
      ["8", "8"],
      ["9", "9"],
    ]);
    expect(merged[1]).toBe(grown);
    // The held list is not changed under the reader.
    expect(held[1].endSeq).toBe("2");
  });

  it("keeps the run's seq 1 and a subagent's seq 1 as two entries (negative)", () => {
    const merged = mergeEntries(
      [entry("1")],
      [entry("1", { subagent: sub }), entry("1", { subagent: sub, frames: 3 })],
    );
    expect(merged.map(entryKey)).toEqual(["1", `${CHAIN}:1`]);
    // The second copy of the subagent's entry replaced the first.
    expect(merged[1]?.frames).toBe(3);
  });

  it("answers the held entries for an empty page", () => {
    const held = [entry("1")] as const;
    expect(mergeEntries(held, [])).toEqual([entry("1")]);
  });
});

// ── The feed ────────────────────────────────────────────────────────────────

/** The one row of `kind` the feed drew, or a failing test. */
function only<K extends FeedRow["kind"]>(
  rows: readonly FeedRow[],
  kind: K,
): Extract<FeedRow, { kind: K }> {
  const found = rows.filter(
    (row): row is Extract<FeedRow, { kind: K }> => row.kind === kind,
  );
  if (found.length !== 1)
    throw new Error(`expected one ${kind} row, got ${String(found.length)}`);
  const [row] = found;
  if (row === undefined) throw new Error(`no ${kind} row`);
  return row;
}

function tools(rows: readonly FeedRow[]) {
  return rows.flatMap((row) => (row.kind === "tool" ? [row] : []));
}

const frame = (over: Partial<TranscriptEntry>): TranscriptEntry =>
  transcriptEntry({
    endSeq: over.seq ?? "11",
    kind: "frame",
    request: null,
    response: null,
    decision: null,
    cost: null,
    cumulativeCost: null,
    usage: null,
    kinds: [],
    turn: 1,
    ...over,
  });

describe("buildFeed over the release run", () => {
  const rows = buildFeed(releaseTranscript().entries);

  it("reads as the design's rows, in the order the run happened", () => {
    expect(rows.map((row) => row.kind)).toEqual([
      "prompt",
      "recall",
      "thinking",
      "text",
      "usage",
      "tool",
      "text",
      "usage",
      "tool",
      "text",
      "usage",
      "tool",
      "tool",
      "thinking",
      "text",
      "usage",
      "tool",
      "text",
      "usage",
      "tool",
    ]);
    // The agent's start and the model's request carry nothing to read: no row.
    expect(rows.some((row) => row.key === "s0")).toBe(false);
  });

  it("files every row under the chip that shows it", () => {
    const count = (group: string) =>
      rows.filter((row) => row.group === group).length;
    expect(
      [
        "prompt",
        "responses",
        "thinking",
        "tools",
        "usage",
        "recall",
        "seal",
      ].map(count),
    ).toEqual([1, 5, 2, 6, 5, 1, 0]);
  });

  it("marks the run's first prompt, and reads it from turn_start", () => {
    const prompt = only(rows, "prompt");
    expect(prompt.first).toBe(true);
    expect(prompt.turn).toBe(1);
    expect(prompt.text).toMatch(/^Cut the 4\.11\.0 release notes/);
  });

  it("draws a call the reply named and a tool step recorded as one row, with the decision keyed to it", () => {
    const list = tools(rows).filter(
      (row) => row.call.name === "github__list_pull_requests",
    );
    expect(list).toHaveLength(1);
    const [row] = list;
    expect(row?.call.arg).toBe("a-intel/platform · state closed · base main");
    expect(row?.call.durationMs).toBe(1100);
    expect(row?.call.gates).toEqual([
      {
        decision: "allow",
        frame: { seq: "6", type: "policy_decision", chainRef: null },
      },
    ]);
    expect(row?.call.output?.split("\n")).toHaveLength(7);
    expect(row?.call.frame.seq).toBe("7");
  });

  it("names a Read by its path and reads the file it returned", () => {
    const read = tools(rows).find((row) => row.call.name === "Read");
    expect(read?.call.arg).toBe("…/platform/CHANGELOG.md");
    expect(read?.call.output).toMatch(/^# Changelog/);
    expect(read?.call.diffs).toEqual([]);
  });

  it("reads a new file as a diff of additions, and an edit as its change", () => {
    const write = tools(rows).find((row) => row.call.name === "Write");
    expect(write?.call.diffs).toHaveLength(1);
    expect(write?.call.diffs[0]?.created).toBe(true);
    expect(write?.call.diffs[0]?.diff.removed).toBe(0);
    expect(write?.call.diffs[0]?.diff.added).toBe(13);
    const edit = tools(rows).find((row) => row.call.name === "Edit");
    expect(edit?.call.diffs[0]?.created).toBe(false);
    expect(edit?.call.diffs[0]?.diff).toMatchObject({ added: 2, removed: 2 });
  });

  it("marks the call the recorder filed under errors as failed, and only that one", () => {
    const failed = rows.filter((row) => row.failed);
    expect(failed).toHaveLength(1);
    const [bash] = failed;
    expect(bash?.kind === "tool" && bash.call.name).toBe("Bash");
    expect(bash?.kind === "tool" && bash.call.output).toMatch(
      /error: heading order/,
    );
  });

  it("parks a call on an approval nobody answered, and states no duration for it", () => {
    const release = tools(rows).find(
      (row) => row.call.name === "github__create_release",
    );
    expect(release?.call.parked).toEqual({
      seq: "17",
      type: "approval_request",
      chainRef: null,
    });
    expect(release?.call.pending).toBe(false);
    expect(release?.call.durationMs).toBeNull();
  });

  it("reads what a model step cost, its tokens and the frame that carried them", () => {
    const [first] = rows.flatMap((row) => (row.kind === "usage" ? [row] : []));
    expect(first).toMatchObject({
      model: "claude-opus-5",
      cost: { micros: "412600", currency: "USD", basis: "gateway_observed" },
      usage: { inputUncached: 3368, cacheRead: 12000, output: 412 },
      frame: { seq: "4", type: "model.response", chainRef: null },
      spent: { micros: "412600" },
    });
  });

  it("reads what was recalled from the frame's own list", () => {
    const recall = only(rows, "recall");
    expect(recall.recall).toMatchObject({
      unit: "frames",
      count: 6,
      tokens: 11204,
      cut: null,
    });
    expect(recall.recall.items[0]).toEqual({
      kind: "fact",
      label: "Repository a-intel/platform @ a4c91e2",
      tokens: 1204,
    });
  });
});

describe("buildFeed, the assistant's parked call", () => {
  /** The ledger's two halves of one engine tool call, closed with `label`. */
  const call = (label: string, kinds: TranscriptEntry["kinds"]) => [
    frame({
      seq: "3",
      kind: "tool_call",
      type: "tool.engine_call_started",
      label: "create_workspace",
      callKey: "tool-1-0",
      at: "2026-09-25T12:00:00.000Z",
      request: transcriptBody({
        seq: "3",
        type: "tool.engine_call_started",
        text: '{"name":"ops"}',
      }),
      kinds: ["tools"],
    }),
    frame({
      seq: "4",
      kind: "tool_call",
      type: "tool.engine_call_completed",
      label,
      callKey: "tool-1-0",
      at: "2026-09-25T12:00:00.004Z",
      response: transcriptBody({
        seq: "4",
        type: "tool.engine_call_completed",
        text: '"refused: create_workspace is waiting for approval"',
      }),
      kinds,
    }),
  ];

  it("parks the call on its receipt, names the approval, and does not fail it", () => {
    const [row] = tools(
      buildFeed(
        call("create_workspace parked apr_0a1b2c3d4e5f6g7h8j9k0m", ["tools"]),
      ),
    );
    expect(row?.failed).toBe(false);
    expect(row?.call.parked).toEqual({
      seq: "4",
      type: "tool.engine_call_completed",
      chainRef: null,
    });
    expect(row?.call.approvalId).toBe("apr_0a1b2c3d4e5f6g7h8j9k0m");
    expect(row?.call.pending).toBe(false);
  });

  it("still reads a denied receipt as a refusal that parks nothing (negative)", () => {
    const [row] = tools(
      buildFeed(call("create_workspace denied", ["tools", "errors"])),
    );
    expect(row?.failed).toBe(true);
    expect(row?.call.parked).toBeNull();
    expect(row?.call.approvalId).toBeNull();
  });
});

describe("buildFeed, a reply's own shapes", () => {
  const reply = (over: Partial<TranscriptEntry>) =>
    frame({
      seq: "3",
      kind: "model_call",
      type: "llm_call",
      label: "anthropic/claude-opus-5",
      ...over,
    });

  it("draws a call no tool step recorded from the reply's block, with the result a tool_result block kept", () => {
    const rows = buildFeed([
      reply({
        response: transcriptBody({
          seq: "3",
          text: null,
          blocks: [
            { kind: "text", text: "Checking the tree." },
            {
              kind: "tool_use",
              name: "Bash",
              input: { command: "git status --short\ngit log -3" },
              callKey: "toolu_1",
            },
            {
              kind: "tool_result",
              forRef: "toolu_1",
              ok: false,
              summary: "fatal: not a git repository",
            },
          ],
        }),
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["text", "tool"]);
    const [tool] = tools(rows);
    expect(tool?.call).toMatchObject({
      name: "Bash",
      arg: "git status --short",
      raw: "git status --short\ngit log -3",
      output: "fatal: not a git repository",
      pending: false,
    });
    expect(tool?.failed).toBe(true);
  });

  it("names a call by the tool step of the same name when neither side kept a key", () => {
    const rows = buildFeed([
      reply({
        response: transcriptBody({
          seq: "3",
          text: null,
          blocks: [
            {
              kind: "tool_use",
              name: "Read",
              input: { file_path: "/repo/a.ts" },
              callKey: null,
            },
          ],
        }),
      }),
      frame({
        seq: "4",
        kind: "tool_call",
        type: "tool_call",
        label: "Read ok",
        response: transcriptBody({
          seq: "4",
          text: '{"input":{"file_path":"/repo/a.ts"},"output":"x"}',
        }),
      }),
    ]);
    expect(tools(rows)).toHaveLength(1);
    expect(tools(rows)[0]?.key).toBe("s4");
  });

  it("reads the Messages API's JSON as blocks, never as a body to open", () => {
    const rows = buildFeed([
      reply({
        response: transcriptBody({
          seq: "3",
          text: JSON.stringify({
            content: [
              { type: "thinking", thinking: "Read it first." },
              { type: "text", text: "Reading the file." },
              {
                type: "tool_use",
                id: "toolu_9",
                name: "Read",
                input: { file_path: "/repo/b.ts" },
              },
            ],
          }),
        }),
        cost: { micros: "1200", currency: "USD", basis: "gateway_observed" },
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual([
      "thinking",
      "text",
      "usage",
      "tool",
    ]);
    expect(tools(rows)[0]?.call.pending).toBe(true);
  });

  it("reads a chat completion's message as blocks", () => {
    const rows = buildFeed([
      reply({
        response: transcriptBody({
          seq: "3",
          text: JSON.stringify({
            choices: [
              {
                message: {
                  content: "Listing.",
                  tool_calls: [
                    {
                      id: "call_1",
                      function: {
                        name: "list_dir",
                        arguments: '{"path":"src"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
        }),
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["text", "tool"]);
    expect(tools(rows)[0]?.call).toMatchObject({
      name: "list_dir",
      arg: "src",
    });
  });

  it("draws a JSON reply it cannot read by its cost alone (negative)", () => {
    const rows = buildFeed([
      reply({
        response: transcriptBody({ seq: "3", text: '{"id":"msg_1"}' }),
        cost: { micros: "1200", currency: "USD", basis: null },
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["usage"]);
  });

  it("draws nothing for a model step with no words, no tokens and no cost (negative)", () => {
    const rows = buildFeed([
      reply({
        response: transcriptBody({
          seq: "3",
          fidelity: "digest_only",
          bytesRef: null,
          text: null,
        }),
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it("names no model when the label names only the frame's type", () => {
    const rows = buildFeed([
      reply({
        label: "llm_call",
        usage: {
          inputUncached: 5,
          cacheRead: null,
          cacheWrite: null,
          output: 2,
          reasoning: null,
        },
      }),
    ]);
    expect(only(rows, "usage").model).toBeNull();
    expect(only(rows, "usage").cost).toBeNull();
  });
});

describe("buildFeed, the turn's frames", () => {
  it("draws a turn's closing message once when it repeats the model's words", () => {
    const rows = buildFeed([
      frame({
        seq: "1",
        type: "turn_start",
        request: transcriptBody({ seq: "1", text: "Fix the build." }),
      }),
      frame({
        seq: "2",
        kind: "model_call",
        type: "model.response",
        label: "anthropic/claude-opus-5",
        response: transcriptBody({ seq: "2", text: "The build is fixed." }),
      }),
      frame({
        seq: "3",
        type: "turn_end",
        response: transcriptBody({ seq: "3", text: "The build is fixed." }),
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["prompt", "text"]);
  });

  it("reads the reply from the agent's reported message when the turn closed without one", () => {
    // Cursor reports the agent's message apart from `stop`. When `stop`
    // lands first, the turn_end carries no body and the message frame is
    // the only copy of the reply.
    const rows = buildFeed([
      frame({
        seq: "1",
        type: "turn_start",
        request: transcriptBody({ seq: "1", text: "Fix the build." }),
      }),
      frame({ seq: "2", type: "turn_end" }),
      frame({
        seq: "3",
        type: "oxagen:message",
        response: transcriptBody({ seq: "3", text: "The build is fixed." }),
      }),
    ]);
    expect(rows.map((row) => [row.kind, row.group])).toEqual([
      ["prompt", "prompt"],
      ["text", "responses"],
    ]);
  });

  it("draws the prompt once when the transcript's copy of it was sealed with its text", () => {
    // Before #4051 the recorder sealed Claude Code's transcript copy of each
    // prompt with the full text, as a message frame beside the turn_start.
    // It can land on either side of the turn_start.
    const prompt = (seq: string) =>
      frame({
        seq,
        type: "turn_start",
        request: transcriptBody({ seq, text: "Fix the build." }),
      });
    const copy = (seq: string) =>
      frame({
        seq,
        type: "oxagen:message",
        request: transcriptBody({ seq, text: "Fix the build.\n" }),
      });
    const reply = frame({
      seq: "3",
      kind: "model_call",
      type: "model.response",
      label: "anthropic/claude-opus-5",
      response: transcriptBody({ seq: "3", text: "The build is fixed." }),
    });
    for (const entries of [
      [prompt("1"), copy("2"), reply],
      [copy("1"), prompt("2"), reply],
    ]) {
      const rows = buildFeed(entries);
      expect(rows.map((row) => row.kind)).toEqual(["prompt", "text"]);
      expect(only(rows, "text").text).toBe("The build is fixed.");
    }
  });

  it("keeps a subagent's message that repeats the operator's words (negative)", () => {
    const sub = {
      chainRef: "0192d4a8-7c1e-7a00-8000-0000000000c1",
      type: "Explore",
    };
    const rows = buildFeed([
      frame({
        seq: "1",
        type: "turn_start",
        request: transcriptBody({ seq: "1", text: "Find the flaky test." }),
      }),
      frame({
        seq: "2",
        type: "oxagen:message",
        subagent: sub,
        response: transcriptBody({ seq: "2", text: "Find the flaky test." }),
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["prompt", "text"]);
    expect(rows[1]?.subagent).toEqual(sub);
  });

  it("reads no prompt when turn_start carries both halves, rather than guess which (negative)", () => {
    const rows = buildFeed([
      frame({
        seq: "1",
        type: "turn_start",
        request: transcriptBody({ seq: "1", text: "Cut the release." }),
        response: transcriptBody({ seq: "1", text: "Cutting it now." }),
      }),
    ]);
    expect(rows).toEqual([]);
  });

  it("reads the operator's prompt from the run's own chain, not a subagent's", () => {
    const sub = {
      chainRef: "0192d4a8-7c1e-7a00-8000-0000000000c1",
      type: "Explore",
    };
    const rows = buildFeed([
      frame({
        seq: "1",
        type: "turn_start",
        request: transcriptBody({ seq: "1", text: "Find the flaky test." }),
      }),
      frame({
        seq: "0",
        type: "turn_start",
        subagent: sub,
        request: transcriptBody({ seq: "0", text: "Search the test tree." }),
      }),
      frame({
        seq: "3",
        type: "turn_end",
        subagent: sub,
        response: transcriptBody({ seq: "3", text: "Three candidates." }),
      }),
    ]);
    // The subagent's brief is the parent's call, which the call's row
    // already holds; its closing words are its own, marked as its.
    expect(rows.map((row) => row.kind)).toEqual(["prompt", "text"]);
    expect(rows[0]?.subagent).toBeUndefined();
    expect(rows[1]?.subagent).toEqual(sub);
  });

  it("draws the run's stop as its seal, and a subagent's stop as nothing of the run's (negative)", () => {
    const rows = buildFeed([
      frame({
        seq: "2",
        type: "agent_stop",
        turn: null,
        subagent: {
          chainRef: "0192d4a8-7c1e-7a00-8000-0000000000c1",
          type: null,
        },
      }),
      frame({
        seq: "8",
        type: "agent_stop",
        label: "agent_stop completed",
        turn: null,
      }),
    ]);
    expect(rows.map((row) => [row.kind, row.group])).toEqual([
      ["seal", "seal"],
    ]);
    expect(only(rows, "seal").label).toBe("agent_stop completed");
  });

  it("reads a steering manifest's included items, its cut and its tokens", () => {
    const rows = buildFeed([
      frame({
        seq: "1",
        type: "steering.manifest",
        kinds: ["recall"],
        turn: null,
        response: transcriptBody({
          seq: "1",
          text: JSON.stringify({
            schema: "oxagen.steering.manifest/1",
            included: 2,
            cut: 1,
            spent_tokens: 340,
            items: [
              { id: "rec_1", kind: "rule", tokens: 200, outcome: "included" },
              { id: "rec_2", kind: "fact", tokens: 140, outcome: "included" },
              {
                id: "rec_3",
                kind: "fact",
                tokens: 900,
                outcome: "cut",
                reason: "budget",
              },
            ],
          }),
        }),
      }),
    ]);
    expect(only(rows, "recall").recall).toEqual({
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

  it("reads the ledger's frame count from the label when the body carried none", () => {
    const rows = buildFeed([
      frame({
        seq: "1",
        type: "context.frames_selected",
        label: "frames=6",
        kinds: ["recall"],
      }),
    ]);
    expect(only(rows, "recall").recall).toMatchObject({ count: 6, items: [] });
  });

  it("draws an error frame and a decision on no call, and nothing for bookkeeping", () => {
    const rows = buildFeed([
      frame({ seq: "0", type: "oxagen:hook_health" }),
      frame({ seq: "1", type: "oxagen:hook_health" }),
      frame({
        seq: "2",
        type: "error",
        kinds: ["errors"],
        response: transcriptBody({
          seq: "2",
          text: "upstream timeout\nretrying",
        }),
      }),
      frame({
        seq: "3",
        kind: "policy",
        type: "policy_decision",
        label: "deny create_tag",
        decision: {
          seq: "3",
          decision: "deny",
          type: "policy_decision",
          at: transcriptEntry().at,
        },
      }),
      frame({
        seq: "4",
        type: "agent_start",
        turn: null,
        response: transcriptBody({ seq: "4", text: '{"model":"x"}' }),
      }),
    ]);
    expect(rows.map((row) => [row.kind, row.failed])).toEqual([
      ["event", true],
      ["event", true],
    ]);
    const [error, gate] = rows;
    expect(error?.kind === "event" && error.name).toBe("error");
    expect(gate?.kind === "event" && gate.name).toBe("create_tag");
    expect(gate?.kind === "event" && gate.gates[0]?.decision).toBe("deny");
  });
});

describe("decisionSubject", () => {
  it("names the call a gate frame decided on", () => {
    expect(
      decisionSubject(
        transcriptEntry({
          type: "policy_decision",
          kind: "frame",
          label: "deny Bash",
        }),
      ),
    ).toBe("Bash");
  });

  it("names a tool call entry by its tool, whatever frame opened it", () => {
    expect(
      decisionSubject(
        transcriptEntry({ kind: "tool_call", label: "create_tag v4.11.0" }),
      ),
    ).toBe("create_tag");
  });

  it("names no call for a gate that recorded only its decision, or a model call (negative)", () => {
    expect(
      decisionSubject(
        transcriptEntry({
          type: "policy_decision",
          kind: "frame",
          label: "policy deny",
        }),
      ),
    ).toBeNull();
    expect(decisionSubject(transcriptEntry())).toBeNull();
  });
});

describe("isOperatorPrompt", () => {
  it("reads a turn_start on the run's own chain as the operator prompting", () => {
    expect(
      isOperatorPrompt(transcriptEntry({ type: "turn_start", kind: "frame" })),
    ).toBe(true);
  });

  it("reads neither a subagent's turn nor a model request as the operator (negative)", () => {
    expect(
      isOperatorPrompt(
        transcriptEntry({
          type: "turn_start",
          kind: "frame",
          subagent: {
            chainRef: "0192d4a8-7c1e-7a00-8000-0000000000c1",
            type: "Explore",
          },
        }),
      ),
    ).toBe(false);
    expect(
      isOperatorPrompt(
        transcriptEntry({ type: "model.request", kinds: ["prompt"] }),
      ),
    ).toBe(false);
  });
});

// ── Edges of the grouping and the readers ────────────────────────────────────
//
// Every frame below is built from `edgeFrame()`, which starts from nothing: no
// halves, no decision, no cost and no call key. Each test names the fields its
// case depends on, so what a test exercises is readable at the call site
// rather than inherited from the builder's model-call defaults.

const T0 = "2026-09-15T08:00:00.000Z";

function edgeFrame(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
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

describe("buildTranscript: turns", () => {
  it("keeps a turn number reused after a gap as its own group, in recorded order", () => {
    const built = buildTranscript([
      edgeFrame({ seq: "1", turn: 1 }),
      edgeFrame({ seq: "2", turn: 2 }),
      edgeFrame({ seq: "3", turn: 1 }),
    ]);
    expect(built.map((t) => [t.id, t.turn])).toEqual([
      ["t1", 1],
      ["t2", 2],
      ["t3", 1],
    ]);
    // Positions stay the transcript's own, not the group's.
    expect(built[2]?.steps.map((s) => [s.from, s.to])).toEqual([[2, 2]]);
  });
});

describe("pairing a model call's halves", () => {
  it("pairs a keyed request with its response by key, across another frame of the same call", () => {
    const steps = stepsIn([
      edgeFrame({
        seq: "1",
        kind: "model_call",
        type: "model.request",
        label: "anthropic/claude-opus-5",
        callKey: "m1",
      }),
      edgeFrame({ seq: "2", type: "oxagen:stream_tick", callKey: "m1" }),
      edgeFrame({
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
      edgeFrame({
        seq: "1",
        kind: "model_call",
        type: "model.engine_call_started",
        label: "m",
        callKey: "m1",
      }),
      edgeFrame({
        seq: "2",
        kind: "model_call",
        type: "model.response",
        label: "m",
        callKey: "m1",
      }),
      edgeFrame({
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
      edgeFrame({
        seq: "1",
        kind: "model_call",
        type: "model.request",
        label: "m",
        callKey: "m1",
      }),
      edgeFrame({
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
      edgeFrame({
        seq: "1",
        kind: "model_call",
        type: "model.request",
        label: "m",
      }),
      edgeFrame({ seq: "2", type: "oxagen:stream_tick" }),
      edgeFrame({
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
      edgeFrame({
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
      edgeFrame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
      }),
      edgeFrame({
        seq: "2",
        kind: "policy",
        type: "policy_decision",
        label: "allow Bash",
      }),
      edgeFrame({ seq: "3", kind: "model_call", type: "llm_call", label: "m" }),
      edgeFrame({
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
      edgeFrame({
        seq: "1",
        kind: "tool_call",
        type: "tool_call",
        label: "Bash ok",
      }),
      edgeFrame({
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

describe("decisionSubject", () => {
  it("names the call a gate decided on, and nothing when the gate named none", () => {
    expect(
      decisionSubject(
        edgeFrame({
          kind: "policy",
          type: "policy_decision",
          label: "deny Bash",
        }),
      ),
    ).toBe("Bash");
    expect(
      decisionSubject(
        edgeFrame({
          kind: "policy",
          type: "policy_decision",
          label: "policy deny",
        }),
      ),
    ).toBeNull();
    expect(
      decisionSubject(
        edgeFrame({
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
        edgeFrame({ kind: "tool_call", type: "tool_call", label: "Bash ok" }),
      ),
    ).toBe("Bash");
    expect(
      decisionSubject(
        edgeFrame({ kind: "tool_call", type: "tool_requested", label: "Read" }),
      ),
    ).toBe("Read");
    expect(
      decisionSubject(
        edgeFrame({
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
        edgeFrame({ kind: "tool_call", type: "tool_call", label: "tool_call" }),
      ),
    ).toBeNull();
    expect(
      decisionSubject(
        edgeFrame({
          kind: "model_call",
          type: "llm_call",
          label: "anthropic/claude-opus-5",
        }),
      ),
    ).toBeNull();
    expect(
      decisionSubject(edgeFrame({ type: "turn_start", label: "turn_start" })),
    ).toBeNull();
  });
});

describe("stepDigest edges", () => {
  it("names a model step by its whole label when the label carries no provider", () => {
    const d = stepDigest(
      stepOver("model", [
        edgeFrame({
          kind: "model_call",
          type: "llm_call",
          label: "claude-opus-5",
        }),
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
          edgeFrame({
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
          edgeFrame({ kind: "tool_call", type: "tool_call", label: "Bash ok" }),
        ]),
      ).node,
    ).toBe("tool");
  });

  it("reads a tool step's gate from the folded decision before its label, and times it end to end", () => {
    const steps = stepsIn([
      edgeFrame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
        at: T0,
      }),
      edgeFrame({
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
      edgeFrame({
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
      edgeFrame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Read src/app.ts",
      }),
      edgeFrame({
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
        edgeFrame({ kind: "policy", type: "policy_decision", ...over }),
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
      stepDigest(stepOver("event", [edgeFrame({ type, label })]));
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
        stepOver("model", [
          edgeFrame({ kind: "model_call", type: "llm_call" }),
        ]),
      ),
    ).toBeNull();
  });

  it("reads the call's receipt before the request, which holds the input alone", () => {
    const steps = stepsIn([
      edgeFrame({
        seq: "1",
        kind: "tool_call",
        type: "tool_requested",
        label: "Bash",
        request: body("1", '{"command":"ls"}'),
      }),
      edgeFrame({
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
      edgeFrame({
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
      edgeFrame({
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
      edgeFrame({
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
      output: null,
      diffs: [],
    });
  });

  it("is null when neither the label nor a body names the tool (negative)", () => {
    const steps = stepsIn([
      edgeFrame({
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

describe("frameCost", () => {
  const usd = (micros: string): TranscriptEntry["cost"] => ({
    micros,
    currency: "USD",
    basis: "gateway_observed",
  });

  it("is null when no frame carried a cost, rather than a zero (negative)", () => {
    expect(frameCost([])).toBeNull();
    expect(frameCost([edgeFrame(), edgeFrame()])).toBeNull();
  });

  it("sums the frames that carried one and skips the ones that did not", () => {
    expect(
      frameCost([
        edgeFrame({ cost: usd("380000") }),
        edgeFrame(),
        edgeFrame({ cost: usd("120000") }),
      ]),
    ).toEqual({
      micros: "500000",
      currency: "USD",
    });
  });

  it("refuses a total across currencies (negative)", () => {
    expect(
      frameCost([
        edgeFrame({ cost: usd("1") }),
        edgeFrame({ cost: { micros: "1", currency: "EUR", basis: null } }),
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
  const gate = (
    seq: string,
    key: string,
    target: string | null,
    over: Partial<TranscriptEntry> = {},
  ) =>
    frame({
      seq,
      kind: "policy",
      type: "policy_decision",
      label: "allow Bash",
      callKey: key,
      target,
      decision: { seq, decision: "allow", type: "policy_decision", at: T0 },
      ...over,
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
  // Claude Code fires PreToolUse inside a subagent too, so Oxagen gates the
  // subagent's calls on the subagent's chain.
  const subGate = (seq: string, key: string, tool: string, target: string) =>
    gate(seq, key, target, {
      label: `allow ${tool}`,
      subagent: sub,
    });

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
    subGate("0", "toolu_X1", "Grep", "flaky"),
    call("1", "toolu_X1", "Grep ok", body("1", null), { subagent: sub }),
    subGate("2", "toolu_X2", "Read", "apps/app/src/flaky.test.ts"),
    call("3", "toolu_X2", "Read ok", body("3", null), { subagent: sub }),
    call("11", "toolu_C", "Task ok"),
    harness("12", "toolu_D", "deny"),
    harness("13", "toolu_E"),
  ];
  const steps = stepsIn(entries);
  const turn = buildTranscript(entries)[0];
  if (turn === undefined) throw new Error("expected a turn");
  // The rows the Transcript tab draws. The branch this merged into reads the
  // run as a feed of rows (`buildFeed`) where main read it as visible steps
  // under a zoom; each assertion below states the same behaviour of #4026 on
  // the feed.
  const rows = buildFeed(entries);
  const callRows = tools(rows);
  const stepFor = (key: string) => {
    const found = turn.steps.find((s) => s.first.callKey === key);
    if (found === undefined) throw new Error(`expected the ${key} step`);
    return found;
  };
  const rowFor = (key: string) => {
    const id = stepFor(key).id;
    const found = callRows.find((row) => row.key === id);
    if (found === undefined) throw new Error(`expected the ${key} row`);
    return found;
  };

  it("draws one step per call, not one row per permission check", () => {
    const calls = turn.steps.filter((s) => s.kind === "tool");
    expect(calls.map((s) => stepDigest(s).name)).toEqual([
      "Bash",
      "Bash",
      "Task",
    ]);
    expect(calls[0]?.frames.map((f) => f.seq)).toEqual(["2", "4", "6"]);
    expect(calls[1]?.frames.map((f) => f.seq)).toEqual(["3", "5", "7"]);
    expect(
      callRows.filter((row) => row.parent === null).map((row) => row.call.name),
    ).toEqual(["Bash", "Bash", "Task"]);
  });

  it("shows the command the gate recorded when the call kept no body", () => {
    const fetch = stepFor("toolu_A");
    expect(stepDigest(fetch)).toMatchObject({
      node: "tool",
      arg: "git fetch origin main",
    });
    const detail = stepTool(fetch);
    expect(detail?.headline).toBe("git fetch origin main");
    // Main drew the target as a command pane; the feed draws the call as it
    // was made in the row's fold (`raw`), and its headline as the argument.
    expect(detail?.raw).toBe("git fetch origin main");
    expect(rowFor("toolu_A").call).toMatchObject({
      name: "Bash",
      arg: "git fetch origin main",
      raw: "git fetch origin main",
    });
  });

  it("shows the command and its output when the call kept its body", () => {
    const detail = stepTool(stepFor("toolu_B"));
    expect(detail?.headline).toBe("git status");
    expect(detail?.output).toBe("nothing to commit");
    // The harness's allow says nothing the call does not: the row carries
    // Oxagen's gate and no chip for the harness's check.
    expect(
      rowFor("toolu_B").call.gates.map((gate) => [
        gate.frame.type,
        gate.frame.seq,
      ]),
    ).toEqual([["policy_decision", "3"]]);
  });

  it("nests the subagent's calls under the Task call that spawned it", () => {
    const task = stepFor("toolu_C");
    expect(task.frames.map((f) => f.type)).toContain("subagent_start");
    expect(task.children?.map((s) => stepDigest(s).name)).toEqual([
      "Grep",
      "Read",
    ]);
    expect(steps.some((s) => s.first.subagent !== undefined)).toBe(false);
    // In the feed the subagent's rows follow the Task row and name it.
    const nested = callRows.filter((row) => row.parent === task.id);
    expect(nested.map((row) => [row.call.name, row.call.arg])).toEqual([
      ["Grep", "flaky"],
      ["Read", "apps/app/src/flaky.test.ts"],
    ]);
    const order = callRows.map((row) => row.call.name);
    expect(order.indexOf("Grep")).toBe(order.indexOf("Task") + 1);
    // A reader that counts steps still sees the subagent's, in recorded order.
    expect(flatSteps(turn).map((s) => s.id)).toContain(task.children?.[0]?.id);
  });

  it("shows a harness refusal and hides a harness allow with nothing else", () => {
    const refused = rows.filter((row) => row.key === stepFor("toolu_D").id);
    expect(refused).toEqual([
      expect.objectContaining({ kind: "event", name: "Bash", failed: true }),
    ]);
    expect(rows.some((row) => row.key === stepFor("toolu_E").id)).toBe(false);
    const harnessRows = rows.filter((row) =>
      turn.steps.some(
        (s) => s.id === row.key && s.first.type === "harness_permission",
      ),
    );
    expect(harnessRows).toHaveLength(1);
  });
});

describe("a call whose step opens on Oxagen's gate", () => {
  // Oxagen decides before the call's own frames land, so a step gathered on
  // the call key opens on the gate. The receipt and the frame a row links are
  // looked for among the call's frames, never taken from the first.
  const gate = frame({
    seq: "1",
    kind: "policy",
    type: "policy_decision",
    label: "allow Bash",
    callKey: "tc_1",
    decision: { seq: "1", decision: "allow", type: "policy_decision", at: T0 },
  });
  const request = frame({
    seq: "2",
    kind: "tool_call",
    type: "tool_requested",
    label: "Bash",
    callKey: "tc_1",
  });
  // A completed call in the ledger's own vocabulary, not a wrapped tool_call.
  const receipt = frame({
    seq: "3",
    kind: "tool_call",
    type: "tool.call_completed",
    label: "Bash ok",
    callKey: "tc_1",
    response: body("3", null),
  });
  const callOf = (entries: TranscriptEntry[]) => {
    const row = buildFeed(entries).find((r) => r.kind === "tool");
    if (row?.kind !== "tool") throw new Error("expected a tool row");
    return row.call;
  };

  it("reads the call done and links its receipt", () => {
    const call = callOf([gate, request, receipt]);
    expect(call.pending).toBe(false);
    expect(call.frame).toEqual({
      seq: "3",
      type: "tool.call_completed",
      chainRef: null,
    });
  });

  it("links a call still waiting to its request, never to the gate (negative)", () => {
    const call = callOf([gate, request]);
    expect(call.pending).toBe(true);
    expect(call.frame).toEqual({
      seq: "2",
      type: "tool_requested",
      chainRef: null,
    });
  });
});
