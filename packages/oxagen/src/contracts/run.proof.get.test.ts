import { describe, expect, it } from "vitest";
import { runProofGet } from "./run.proof.get";

const d = (c: string) => `sha256:${c.repeat(64)}`;

function attempt(over: Record<string, unknown> = {}) {
  return {
    attemptNo: 3,
    frameSeq: "71",
    observedAt: "2026-09-15T09:09:33.201Z",
    targetRef: "main",
    targetSha: "a4c91e2",
    prRef: "refs/pull/482/head",
    prSha: "f70b3d9",
    targetResult: "fail",
    prResult: "pass",
    verdict: "flipped",
    failFingerprint: d("2"),
    passOutputDigest: d("3"),
    tamperExclusion: "held",
    tamper: null,
    disclosureGrain: "L0",
    witnessRunId: "tse_01k5rq5w7t2hvn9k",
    runnerAttestation: { keyId: "kms:witness/v3", signature: "MEUCIQ" },
    ...over,
  };
}

function proof(over: Record<string, unknown> = {}) {
  return {
    runId: "tse_01k5rq4b9c7xtn2p",
    verdict: "flipped",
    witnesses: [
      {
        witnessId: "wit_01K5RQ8M4",
        oracle: "test_flip",
        commandDigest: d("1"),
        heldOut: false,
        verdict: "flipped",
        attempts: [attempt()],
      },
    ],
    witnessRuns: [
      {
        runId: "tse_01k5rq5w7t2hvn9k",
        cost: { micros: "610000", currency: "USD", basis: "gateway_observed" },
      },
    ],
    disclosureGrain: "L0",
    ...over,
  };
}

describe("get_run_proof contract", () => {
  it("is an unbilled read on the API alone, never an MCP tool", () => {
    expect(runProofGet.noBillingGate).toBe(true);
    expect(runProofGet.mutates).toBe(false);
    expect(runProofGet.surfaces).toEqual(["api"]);
    expect(runProofGet.input.safeParse({ runId: "tse_abc123" }).success).toBe(
      true,
    );
    expect(runProofGet.input.safeParse({ runId: "wit_abc" }).success).toBe(
      false,
    );
  });

  it("carries a run with a flip, and the none state with no witness", () => {
    expect(runProofGet.output.parse(proof()).verdict).toBe("flipped");
    expect(
      runProofGet.output.parse(
        proof({ verdict: null, witnesses: [], witnessRuns: [] }),
      ).witnesses,
    ).toEqual([]);
  });

  it("carries the tamper fingerprints on a tampered attempt", () => {
    const tampered = attempt({
      verdict: "tampered",
      prResult: "excluded",
      passOutputDigest: null,
      tamperExclusion: "broken",
      tamper: { fingerprintAuthored: d("4"), fingerprintAtRun: d("5") },
    });
    const parsed = runProofGet.output.parse(
      proof({
        verdict: "tampered",
        witnesses: [
          {
            ...proof().witnesses[0],
            verdict: "tampered",
            attempts: [tampered],
          },
        ],
      }),
    );
    expect(parsed.witnesses[0]?.attempts[0]?.tamper).toEqual({
      fingerprintAuthored: d("4"),
      fingerprintAtRun: d("5"),
    });
  });

  it("refuses a word outside the closed vocabularies (negative)", () => {
    expect(
      runProofGet.output.safeParse(proof({ verdict: "proven" })).success,
    ).toBe(false);
    expect(
      runProofGet.output.safeParse(proof({ disclosureGrain: "L4" })).success,
    ).toBe(false);
  });

  it("refuses a witness with no attempt and a field the record does not hold (negative)", () => {
    expect(
      runProofGet.output.safeParse(
        proof({ witnesses: [{ ...proof().witnesses[0], attempts: [] }] }),
      ).success,
    ).toBe(false);
    expect(
      runProofGet.output.safeParse(
        proof({
          witnesses: [
            {
              ...proof().witnesses[0],
              command: "pnpm vitest run notes.test.ts",
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });
});
