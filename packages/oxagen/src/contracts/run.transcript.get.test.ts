import { describe, expect, it } from "vitest";
import {
  runTranscriptGet,
  TRANSCRIPT_ENTRY_MAX,
  TRANSCRIPT_STEP_TEXT_MAX,
  TRANSCRIPT_TEXT_MAX,
  transcriptTextMax,
  transcriptBodySchema,
  transcriptEntrySchema,
} from "./run.transcript.get";

const RUN = "tse_0a1b2c3d4e";

const half = {
  seq: "3",
  type: "tool_requested",
  digest: `sha256:${"a".repeat(64)}`,
  bytesRef: "evb:v1:k:abc",
  redactions: [],
  fidelity: "full",
  text: '{"path":"README.md"}',
  truncated: false,
  assembly: null,
};

const entry = {
  seq: "3",
  endSeq: "5",
  at: "2026-09-11T10:00:03.000Z",
  elapsedMs: 3000,
  kind: "tool_call",
  type: "tool_requested",
  label: "Read ok",
  callId: "tu_shared",
  kinds: ["tools"],
  request: half,
  response: { ...half, seq: "5", type: "tool_call", text: "# Oxagen" },
  decision: null,
  frames: 3,
  turn: 2,
  cost: null,
  cumulativeCost: null,
};

const input = (over: Record<string, unknown> = {}) =>
  runTranscriptGet.input.safeParse({ runId: RUN, zoom: "steps", ...over });

describe("get_run_transcript contract", () => {
  it("is a console read: mutates false, noBillingGate true", () => {
    expect(runTranscriptGet.mutates).toBe(false);
    expect(runTranscriptGet.noBillingGate).toBe(true);
    expect(runTranscriptGet.scoped).toBe(true);
    expect(runTranscriptGet.defaultEffect).toBe("deny");
  });

  it("requires one of the three zoom levels (negative)", () => {
    for (const zoom of ["turns", "steps", "everything"]) {
      expect(input({ zoom }).success).toBe(true);
    }
    expect(input({ zoom: "frames" }).success).toBe(false);
    expect(runTranscriptGet.input.safeParse({ runId: RUN }).success).toBe(
      false,
    );
  });

  it("defaults to every chip and one page, and refuses a chip outside the set (negative)", () => {
    const parsed = input();
    expect(parsed.success && parsed.data.kinds).toEqual([]);
    expect(parsed.success && parsed.data.limit).toBe(200);
    expect(input({ kinds: ["tools", "errors"] }).success).toBe(true);
    // `thinking` and `seal` are published now that producers record them: a
    // model call that spent reasoning tokens, and the run's seal frame.
    expect(input({ kinds: ["thinking", "seal"] }).success).toBe(true);
    // A chip no producer records is refused rather than offered as a filter
    // that can only ever answer "none".
    expect(input({ kinds: ["frames"] }).success).toBe(false);
    expect(input({ limit: 0 }).success).toBe(false);
    expect(input({ limit: 501 }).success).toBe(false);
  });

  it("carries both halves of one step, each with its own digest and fidelity", () => {
    expect(transcriptEntrySchema.safeParse(entry).success).toBe(true);
    // A producer that appends a single terminal receipt has no request half.
    expect(
      transcriptEntrySchema.safeParse({ ...entry, request: null }).success,
    ).toBe(true);
    expect(
      transcriptEntrySchema.safeParse({
        ...entry,
        response: {
          ...half,
          text: null,
          bytesRef: null,
          fidelity: "digest_only",
        },
      }).success,
    ).toBe(true);
  });

  it("bounds each half's text and refuses a fidelity word outside the set (negative)", () => {
    expect(
      transcriptBodySchema.safeParse({ ...half, fidelity: "partial" }).success,
    ).toBe(false);
    expect(
      transcriptBodySchema.safeParse({
        ...half,
        text: "x".repeat(TRANSCRIPT_TEXT_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      transcriptEntrySchema.safeParse({ ...entry, frames: 0 }).success,
    ).toBe(false);
    // Elapsed is measured from the run's start and is never negative.
    expect(
      transcriptEntrySchema.safeParse({ ...entry, elapsedMs: -1 }).success,
    ).toBe(false);
    // A frame recorded before the run's first turn is in no turn.
    expect(
      transcriptEntrySchema.safeParse({ ...entry, turn: null }).success,
    ).toBe(true);
    expect(transcriptEntrySchema.safeParse({ ...entry, turn: 0 }).success).toBe(
      false,
    );
  });

  it("carries a decision inline when one was folded into the step", () => {
    expect(
      transcriptEntrySchema.safeParse({
        ...entry,
        decision: {
          seq: "4",
          decision: "route",
          type: "policy_decision",
          at: "2026-09-11T10:00:04.000Z",
        },
      }).success,
    ).toBe(true);
  });

  it("bounds one page and says when the transcript was cut", () => {
    expect(
      runTranscriptGet.output.safeParse({
        zoom: "everything",
        kinds: [],
        entries: [entry],
        cursor: null,
        complete: true,
      }).success,
    ).toBe(true);
    expect(
      runTranscriptGet.output.safeParse({
        zoom: "everything",
        kinds: [],
        entries: Array.from({ length: TRANSCRIPT_ENTRY_MAX + 1 }, () => entry),
        cursor: null,
        complete: false,
      }).success,
    ).toBe(false);
  });
});

describe("transcriptTextMax", () => {
  it("carries the whole body per frame, and an excerpt per folded exchange", () => {
    expect(transcriptTextMax("everything")).toBe(TRANSCRIPT_TEXT_MAX);
    expect(transcriptTextMax("steps")).toBe(TRANSCRIPT_STEP_TEXT_MAX);
    expect(transcriptTextMax("turns")).toBe(TRANSCRIPT_STEP_TEXT_MAX);
    // The folded cap is genuinely smaller: a page of 200 steps at the full cap
    // is megabytes of body text nobody asked for on that render.
    expect(TRANSCRIPT_STEP_TEXT_MAX).toBeLessThan(TRANSCRIPT_TEXT_MAX);
  });
});
