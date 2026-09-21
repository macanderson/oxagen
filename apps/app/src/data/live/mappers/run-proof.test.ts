import { describe, expect, it } from "vitest";
import { RunProof } from "@/data/contracts/run-proof";
import { runProof } from "@/features/run/run.builders";
import { toRunProof } from "./run-proof";

describe("proof view mapping", () => {
  it("retains the populated witness attempt and security facts through parsing", () => {
    const fixture = { ...runProof(), witnessRuns: [] };
    expect(RunProof.parse(toRunProof(fixture))).toEqual(fixture);
  });
  it("preserves an absent verdict and unknown witness cost", () => {
    expect(
      RunProof.parse(
        toRunProof({
          runId: "tse_run1",
          verdict: null,
          disclosureGrain: "L0",
          witnesses: [],
          witnessRuns: [{ runId: "arun_witness1", cost: null }],
        }),
      ),
    ).toEqual({
      runId: "tse_run1",
      verdict: null,
      disclosureGrain: "L0",
      witnesses: [],
      witnessRuns: [{ runId: "arun_witness1", cost: null }],
    });
  });
  it("keeps precise micros and the recorded cost basis", () => {
    const proof = RunProof.parse(
      toRunProof({
        runId: "tse_run1",
        verdict: "flipped",
        disclosureGrain: "L2",
        witnesses: [],
        witnessRuns: [
          {
            runId: "arun_witness1",
            cost: {
              micros: "9007199254740993",
              currency: "USD",
              basis: "client_attested",
            },
          },
        ],
      }),
    );
    expect(proof.witnessRuns[0]?.cost).toEqual({
      micros: "9007199254740993",
      currency: "USD",
      basis: "client_attested",
    });
  });
});
