import { describe, expect, it } from "vitest";
import {
  runTranscriptGet,
  TRANSCRIPT_ENTRY_MAX,
  TRANSCRIPT_TEXT_MAX,
  transcriptEntrySchema,
} from "./run.transcript.get";

const RUN = "tse_0a1b2c3d4e";

const entry = {
  seq: "3",
  endSeq: "5",
  at: "2026-09-11T10:00:03.000Z",
  kind: "tool_call",
  type: "tool_call",
  label: "Read ok",
  text: '{"path":"README.md"}',
  truncated: false,
  fidelity: "full",
  frames: 3,
  cost: null,
};

describe("get_run_transcript contract", () => {
  it("is a console read: mutates false, noBillingGate true", () => {
    expect(runTranscriptGet.mutates).toBe(false);
    expect(runTranscriptGet.noBillingGate).toBe(true);
    expect(runTranscriptGet.scoped).toBe(true);
    expect(runTranscriptGet.defaultEffect).toBe("deny");
  });

  it("requires one of the three zoom levels (negative)", () => {
    for (const zoom of ["turns", "steps", "everything"]) {
      expect(
        runTranscriptGet.input.safeParse({ runId: RUN, zoom }).success,
      ).toBe(true);
    }
    expect(
      runTranscriptGet.input.safeParse({ runId: RUN, zoom: "frames" }).success,
    ).toBe(false);
    expect(runTranscriptGet.input.safeParse({ runId: RUN }).success).toBe(
      false,
    );
  });

  it("carries the fidelity word on every entry and bounds the text", () => {
    expect(transcriptEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      transcriptEntrySchema.safeParse({
        ...entry,
        text: null,
        fidelity: "digest_only",
      }).success,
    ).toBe(true);
    expect(
      transcriptEntrySchema.safeParse({ ...entry, fidelity: "partial" })
        .success,
    ).toBe(false);
    expect(
      transcriptEntrySchema.safeParse({
        ...entry,
        text: "x".repeat(TRANSCRIPT_TEXT_MAX + 1),
      }).success,
    ).toBe(false);
    expect(
      transcriptEntrySchema.safeParse({ ...entry, frames: 0 }).success,
    ).toBe(false);
  });

  it("bounds the transcript and says when it was cut", () => {
    expect(
      runTranscriptGet.output.safeParse({
        zoom: "everything",
        entries: [entry],
        complete: true,
      }).success,
    ).toBe(true);
    expect(
      runTranscriptGet.output.safeParse({
        zoom: "everything",
        entries: Array.from({ length: TRANSCRIPT_ENTRY_MAX + 1 }, () => entry),
        complete: false,
      }).success,
    ).toBe(false);
  });
});
