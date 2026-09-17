import { describe, expect, it } from "vitest";
import { findingFixRecord } from "./finding.fix.record";

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

describe("record_finding_fix contract", () => {
  it("is a mutating console write that never meters (INV-28)", () => {
    expect(findingFixRecord.mutates).toBe(true);
    expect(findingFixRecord.noBillingGate).toBe(true);
  });

  it("makes an agent wait for a person before recording a fix (INV-14)", () => {
    expect(findingFixRecord.surfaces).toContain("agent");
    expect(findingFixRecord.agent?.requiresApproval).toBe(true);
  });

  it("addresses a finding by its public id only", () => {
    expect(
      findingFixRecord.input.safeParse({ findingId: finding.id }).success,
    ).toBe(true);
    expect(
      findingFixRecord.input.safeParse({ findingId: "fnd_UPPER" }).success,
    ).toBe(false);
    expect(
      findingFixRecord.input.safeParse({ findingId: finding.id, extra: 1 })
        .success,
    ).toBe(false);
  });

  it("answers the applied finding with the action id", () => {
    const out = {
      finding: {
        ...finding,
        status: "applied",
        decidedAt: "2026-09-15T09:00:00.000Z",
        appliedActionId: "req_1",
      },
    };
    expect(findingFixRecord.output.parse(out)).toEqual(out);
  });
});
