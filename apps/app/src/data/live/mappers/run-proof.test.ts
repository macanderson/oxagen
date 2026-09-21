import type { runProofGet } from "@oxagen/oxagen/contracts/run.proof.get";
import { describe, expect, it } from "vitest";
import { RunProof } from "@/data/contracts/run-proof";
import type { ContractOutput } from "@/server/kernel";
import { toRunProof } from "./run-proof";

// The fixture is the kernel's output shape, which is what the mapper reads.
// It is spelled out here rather than borrowed from the Run page's builders:
// a mapper test may not reach into a feature's internals, and the two shapes
// are no longer interchangeable. The kernel names the witness and the signing
// key `witnessId` and `keyId`; INV-11 makes the view model carry both as
// `…Ref`, because neither is a public id Oxagen mints.
const kernelProof: ContractOutput<typeof runProofGet> = {
  runId: "tse_7k2m9q",
  verdict: "flipped",
  disclosureGrain: "L0",
  witnesses: [
    {
      witnessId: "witness-tests",
      oracle: "test_flip",
      commandDigest: "sha256:command",
      heldOut: true,
      verdict: "flipped",
      attempts: [
        {
          attemptNo: 1,
          frameSeq: "42",
          observedAt: "2026-09-20T12:00:00.000Z",
          targetRef: "main",
          targetSha: "abc123",
          prRef: "fix/witness",
          prSha: "def456",
          targetResult: "fail",
          prResult: "pass",
          verdict: "flipped",
          failFingerprint: "sha256:failure",
          passOutputDigest: "sha256:output",
          tamperExclusion: "held",
          tamper: null,
          disclosureGrain: "L0",
          witnessRunId: "arun_witness1",
          runnerAttestation: {
            keyId: "runner-key-1",
            signature: "recorded-signature",
          },
        },
      ],
    },
  ],
  witnessRuns: [],
};

describe("proof view mapping", () => {
  it("retains the populated witness attempt and security facts through parsing", () => {
    const view = RunProof.parse(toRunProof(kernelProof));
    expect(view.witnesses).toHaveLength(1);
    expect(view.witnesses[0]?.attempts[0]).toMatchObject({
      attemptNo: 1,
      targetResult: "fail",
      prResult: "pass",
      verdict: "flipped",
      failFingerprint: "sha256:failure",
      passOutputDigest: "sha256:output",
      tamperExclusion: "held",
      witnessRunId: "arun_witness1",
    });
  });
  it("carries the kernel's witness and key identifiers as references", () => {
    const view = RunProof.parse(toRunProof(kernelProof));
    expect(view.witnesses[0]?.witnessRef).toBe("witness-tests");
    expect(view.witnesses[0]?.attempts[0]?.runnerAttestation).toEqual({
      keyRef: "runner-key-1",
      signature: "recorded-signature",
    });
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
