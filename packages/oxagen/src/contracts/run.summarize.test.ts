import { describe, expect, it } from "vitest";
import { runSummarize } from "./run.summarize";

const RUN = "tse_0a1b2c3d4e";

describe("summarize_run contract", () => {
  it("is an async write for org Owner, Admin and Member", () => {
    expect(runSummarize.mode).toBe("async");
    expect(runSummarize.mutates).toBe(true);
    expect(runSummarize.noBillingGate).toBe(true);
    expect(runSummarize.defaultRoles?.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
    });
  });

  it("takes a run id and answers queued (negative on any other status)", () => {
    expect(runSummarize.input.safeParse({ runId: RUN }).success).toBe(true);
    expect(runSummarize.input.safeParse({ runId: "x" }).success).toBe(false);
    expect(
      runSummarize.output.safeParse({ runId: RUN, status: "queued" }).success,
    ).toBe(true);
    expect(
      runSummarize.output.safeParse({ runId: RUN, status: "ready" }).success,
    ).toBe(false);
  });
});
