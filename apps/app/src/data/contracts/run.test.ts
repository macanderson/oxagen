import {
  TRANSCRIPT_ENTRY_DEFAULT as CONTRACT_TRANSCRIPT_ENTRY_DEFAULT,
  TRANSCRIPT_ENTRY_MAX as CONTRACT_TRANSCRIPT_ENTRY_MAX,
  TRANSCRIPT_MATCHES as CONTRACT_TRANSCRIPT_MATCHES,
  TRANSCRIPT_QUERY_MAX as CONTRACT_TRANSCRIPT_QUERY_MAX,
  TRANSCRIPT_TEXTS as CONTRACT_TRANSCRIPT_TEXTS,
  toolFamilySchema,
  transcriptKindSchema,
  transcriptNodeSchema,
  transcriptOutcomeSchema,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import { describe, expect, it } from "vitest";
import {
  TOOL_FAMILIES,
  TRANSCRIPT_ENTRY_DEFAULT,
  TRANSCRIPT_ENTRY_MAX,
  TRANSCRIPT_KINDS,
  TRANSCRIPT_MATCHES,
  TRANSCRIPT_NODES,
  TRANSCRIPT_OUTCOMES,
  TRANSCRIPT_QUERY_MAX,
  TranscriptText,
} from "./run";

// The Run page's transcript is a client component, and the kernel's contract
// module reaches `@oxagen/run-evidence` and the Context Graph SDK, which
// import Node builtins. Importing it from a `"use client"` file puts
// `node:readline` in a browser chunk and fails the Turbopack build, so the
// value the client needs is mirrored in `./run` and this test is what keeps
// the mirror honest. Tests run under Node, where the contract imports fine.
describe("run contract mirrors", () => {
  it("mirrors the transcript page size the contract defaults to", () => {
    expect(TRANSCRIPT_ENTRY_DEFAULT).toBe(CONTRACT_TRANSCRIPT_ENTRY_DEFAULT);
  });

  it("mirrors the largest transcript page the contract allows", () => {
    expect(TRANSCRIPT_ENTRY_MAX).toBe(CONTRACT_TRANSCRIPT_ENTRY_MAX);
  });

  it("mirrors the longest search the contract takes", () => {
    expect(TRANSCRIPT_QUERY_MAX).toBe(CONTRACT_TRANSCRIPT_QUERY_MAX);
  });

  // Each list is the one the contract publishes as an enum, in its order, so
  // a value the server sends is one the page can read, and a chip the page
  // draws is one the server counts.
  it("mirrors the vocabularies an entry and its counts are read in", () => {
    expect(TRANSCRIPT_KINDS).toEqual(transcriptKindSchema.options);
    expect(TRANSCRIPT_NODES).toEqual(transcriptNodeSchema.options);
    expect(TRANSCRIPT_OUTCOMES).toEqual(transcriptOutcomeSchema.options);
    expect(TOOL_FAMILIES).toEqual(toolFamilySchema.options);
    expect(TRANSCRIPT_MATCHES).toEqual(CONTRACT_TRANSCRIPT_MATCHES);
    expect(TranscriptText.options).toEqual(CONTRACT_TRANSCRIPT_TEXTS);
  });
});
