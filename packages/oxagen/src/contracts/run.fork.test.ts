import { describe, expect, it } from "vitest";
import { runFork } from "./run.fork";

const RUN = "arun_5f0c2e9a1b7d4c3e8f6a02";

describe("fork_run contract", () => {
  it("is a write for org Owner, Admin and Member that needs no approval", () => {
    expect(runFork.mutates).toBe(true);
    expect(runFork.noBillingGate).toBe(true);
    expect(runFork.agent?.requiresApproval).toBe(false);
    expect(runFork.defaultRoles?.org).toEqual({
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
    });
  });

  it("accepts only an evidence-ledger run and a branch point of at least 1 (negative)", () => {
    expect(runFork.input.safeParse({ runId: RUN, fromSeq: "1" }).success).toBe(
      true,
    );
    expect(runFork.input.safeParse({ runId: RUN, fromSeq: "0" }).success).toBe(
      false,
    );
    expect(
      runFork.input.safeParse({ runId: "tse_0a1b2c", fromSeq: "1" }).success,
    ).toBe(false);
    expect(runFork.input.safeParse({ runId: RUN, fromSeq: 1 }).success).toBe(
      false,
    );
  });

  it("answers the minted attempt", () => {
    expect(
      runFork.output.safeParse({
        attemptId: "arat_0123456789abcdefghjkmn",
        attemptNumber: 2,
      }).success,
    ).toBe(true);
    expect(
      runFork.output.safeParse({ attemptId: "arun_1", attemptNumber: 2 })
        .success,
    ).toBe(false);
  });
});
