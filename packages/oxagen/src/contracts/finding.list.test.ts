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

  it("narrows to one run and carries what each finding cites there (#4001)", () => {
    expect(findingList.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(findingList.input.parse({ runId: "tse_4q8r1t6v" })).toEqual({
      status: "open",
      runId: "tse_4q8r1t6v",
    });
    expect(findingList.input.safeParse({ runId: "run_1" }).success).toBe(
      false,
    );
    const cited = {
      ...finding,
      citation: {
        runId: "tse_4q8r1t6v",
        runLevel: false,
        frames: [
          { seq: "12" },
          { seq: "40", sessionUuid: "3f6c0b1e-9a3d-4c2b-8e57-0d1f2a3b4c5d" },
        ],
        framesTotal: 2,
      },
    };
    const out = {
      status: "open",
      window: finding.window,
      saving: finding.saving,
      spend: null,
      share: null,
      annualised: finding.saving,
      counts: { findings: 1, high: 1, medium: 0, operators: 0 },
      findings: [cited],
    };
    expect(findingList.output.parse(out)).toEqual(out);
    // A run-level finding pins no frame, and an older row names none (null).
    for (const citation of [
      { ...cited.citation, runLevel: true, frames: [] },
      { ...cited.citation, frames: null, framesTotal: 0 },
    ])
      expect(
        findingList.output.safeParse({
          ...out,
          findings: [{ ...finding, citation }],
        }).success,
      ).toBe(true);
    // A seq that is not a sequence, and more frames than the cap (negative).
    for (const frames of [
      [{ seq: "tse_1" }],
      Array.from({ length: 51 }, (_, i) => ({ seq: String(i) })),
    ])
      expect(
        findingList.output.safeParse({
          ...out,
          findings: [{ ...finding, citation: { ...cited.citation, frames } }],
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
