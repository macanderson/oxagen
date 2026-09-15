import { describe, expect, it } from "vitest";
import { findingEvidenceGet } from "./finding.evidence.get";

const finding = {
  id: "fnd_0123456789abcdefghjkmn",
  kind: "unpaged_results",
  level: "tool",
  subject: "aws_billing__get_cost_and_usage",
  saving: { micros: "984600000", currency: "USD", basis: "gateway_observed" },
  confidence: "high",
  window: { from: "2026-08-16T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z" },
  why: "88 calls returned more than 20,000 result tokens.",
  fix: "Page the results.",
  runs: 88,
  calls: 3106,
  status: "open",
  detectedAt: "2026-09-15T02:00:00.000Z",
  decidedAt: null,
  appliedActionId: null,
};

const run = {
  runId: "tse_0123456789abcdefghjkmn",
  startedAt: "2026-09-11T06:00:00.000Z",
  calls: 36,
  measuredTokens: 1_483_200,
  counterfactualTokens: 144_000,
  measured: { micros: "24100000", currency: "USD" },
  counterfactual: { micros: "2340000", currency: "USD" },
};

describe("get_finding_evidence contract", () => {
  it("is a console read (INV-28)", () => {
    expect(findingEvidenceGet.noBillingGate).toBe(true);
    expect(findingEvidenceGet.mutates).toBe(false);
  });

  it("addresses a finding by its public id only", () => {
    expect(
      findingEvidenceGet.input.safeParse({ findingId: finding.id }).success,
    ).toBe(true);
    expect(
      findingEvidenceGet.input.safeParse({
        findingId: "0192d4a8-7c1e-7a00-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("answers money on both sides of the counterfactual and itemises at most ten runs", () => {
    const out = {
      finding,
      evidence: {
        calls: 3106,
        coveredCalls: 3100,
        measuredTokens: 127_967_200,
        counterfactualTokens: 12_424_000,
        measured: { micros: "1100000000", currency: "USD" },
        counterfactual: { micros: "115400000", currency: "USD" },
        runs: [run],
      },
    };
    expect(findingEvidenceGet.output.parse(out)).toEqual(out);
    expect(
      findingEvidenceGet.output.safeParse({
        ...out,
        evidence: { ...out.evidence, runs: Array(11).fill(run) },
      }).success,
    ).toBe(false);
  });
});
