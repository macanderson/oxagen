import { describe, expect, it } from "vitest";
import { runBisect } from "./run.bisect";

const A = "arun_5f0c2e9a1b7d4c3e8f6a02";
const B = "tse_0a1b2c3d4e";

describe("bisect_runs contract", () => {
  it("is a console read over two recordings", () => {
    expect(runBisect.mutates).toBe(false);
    expect(runBisect.noBillingGate).toBe(true);
    expect(runBisect.scoped).toBe(true);
  });

  it("accepts a run from either store on either side, and refuses a foreign id (negative)", () => {
    expect(runBisect.input.safeParse({ runA: A, runB: B }).success).toBe(true);
    expect(runBisect.input.safeParse({ runA: A, runB: A }).success).toBe(true);
    expect(runBisect.input.safeParse({ runA: A, runB: "run_1" }).success).toBe(
      false,
    );
  });

  it("answers null for identical runs and the keys at the divergence otherwise", () => {
    expect(
      runBisect.output.safeParse({
        divergentSeq: null,
        keyA: null,
        keyB: null,
        aligned: 12,
      }).success,
    ).toBe(true);
    expect(
      runBisect.output.safeParse({
        divergentSeq: "7",
        keyA: "tool_call:Read:ok",
        keyB: null,
        aligned: 7,
      }).success,
    ).toBe(true);
    expect(
      runBisect.output.safeParse({
        divergentSeq: 7,
        keyA: null,
        keyB: null,
        aligned: 7,
      }).success,
    ).toBe(false);
  });
});
