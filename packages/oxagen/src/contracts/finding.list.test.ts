import { describe, expect, it } from "vitest";
import { findingList } from "./finding.list";

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

describe("list_findings contract", () => {
  it("is a console read (INV-28)", () => {
    expect(findingList.noBillingGate).toBe(true);
    expect(findingList.mutates).toBe(false);
  });

  it("lists open findings by default and refuses an unknown status", () => {
    expect(findingList.input.parse({})).toEqual({ status: "open" });
    expect(findingList.input.safeParse({ status: "stale" }).success).toBe(
      false,
    );
  });

  it("carries a saving with its basis and refuses one without", () => {
    const out = {
      status: "open",
      window: finding.window,
      saving: finding.saving,
      spend: { micros: "9000000000", currency: "USD", basis: "mixed" },
      share: 0.11,
      annualised: {
        micros: "11979300000",
        currency: "USD",
        basis: "gateway_observed",
      },
      counts: { findings: 1, high: 1, medium: 0, operators: 2 },
      findings: [finding],
    };
    expect(findingList.output.parse(out)).toEqual(out);
    expect(
      findingList.output.safeParse({
        ...out,
        findings: [{ ...finding, saving: { micros: "1", currency: "USD" } }],
      }).success,
    ).toBe(false);
  });

  it("refuses a finding that cites no run", () => {
    expect(
      findingList.output.safeParse({
        status: "open",
        window: null,
        saving: null,
        spend: null,
        share: null,
        annualised: null,
        counts: { findings: 1, high: 1, medium: 0, operators: 0 },
        findings: [{ ...finding, runs: 0 }],
      }).success,
    ).toBe(false);
  });
});
