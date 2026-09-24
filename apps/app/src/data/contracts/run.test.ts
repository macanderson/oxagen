import {
  TRANSCRIPT_ENTRY_DEFAULT as CONTRACT_TRANSCRIPT_ENTRY_DEFAULT,
  TRANSCRIPT_ENTRY_MAX as CONTRACT_TRANSCRIPT_ENTRY_MAX,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_ENTRY_DEFAULT, TRANSCRIPT_ENTRY_MAX } from "./run";

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
});
