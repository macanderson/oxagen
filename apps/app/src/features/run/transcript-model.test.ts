// The transcript's grouping, digests and transport arithmetic, without a render.
import { describe, expect, it } from "vitest";
import { mockupTranscript, transcriptEntry } from "./run.builders";
import {
  buildTranscript,
  costAt,
  elapsedAt,
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
  it("sums cost up to a position and never invents one before the first cost", () => {
    expect(costAt(entries, 3)).toBeNull();
    expect(costAt(entries, 4)?.micros).toBe("380000");
    expect(costAt(entries, 12)?.micros).toBe("900000");
  });

  it("measures elapsed time from the first frame", () => {
    expect(elapsedAt(entries, 0)).toBe(0);
    expect(elapsedAt(entries, 12)).toBe(24_000);
    expect(elapsedAt([], 3)).toBe(0);
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
