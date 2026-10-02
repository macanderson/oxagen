import { describe, expect, it } from "vitest";
import {
  SPEND_PER_MERGED_PR_RUNS_MAX,
  spendPerMergedPr,
} from "./spend.per_merged_pr";

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});

const run = (n: number) => ({
  runId: `tse_${String(n).padStart(22, "0")}`,
  startedAt: "2026-09-08T09:00:00.000Z",
  cost: usd("10000000"),
  pullRequests: [
    {
      prKey: `github:acme/core#${n}`,
      url: `https://github.com/acme/core/pull/${n}`,
      state: "merged" as const,
    },
  ],
});

const landed = {
  agentKey: "acme.core.builder",
  boundedRuns: 4,
  unpricedRuns: 0,
  spend: usd("40000000"),
  mergedPrs: 2,
  perMergedPr: usd("20000000"),
  absence: null,
  runs: [run(1), run(2)],
};

const absent = {
  agentKey: "acme.core.reviewer",
  boundedRuns: 1,
  unpricedRuns: 0,
  spend: usd("10000000"),
  mergedPrs: 0,
  perMergedPr: null,
  absence: "no_merged_pr" as const,
  runs: [{ ...run(3), pullRequests: [] }],
};

const out = {
  period: { from: "2026-09-01", to: "2026-09-30" },
  agents: [landed, absent],
};

describe("get_spend_per_merged_pr contract", () => {
  it("is a console read over a day range for everyone who reads spend", () => {
    expect(spendPerMergedPr.name).toBe("get_spend_per_merged_pr");
    expect(spendPerMergedPr.mutates).toBe(false);
    expect(spendPerMergedPr.noBillingGate).toBe(true);
    expect(spendPerMergedPr.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
      workspace: { Owner: "allow", Member: "allow" },
    });
    expect(
      spendPerMergedPr.input.safeParse({
        period: { from: "2026-09-01", to: "2026-09-30" },
      }).success,
    ).toBe(true);
    expect(spendPerMergedPr.input.safeParse({}).success).toBe(false);
    expect(
      spendPerMergedPr.input.safeParse({
        period: { from: "2026-09-30", to: "2026-09-01" },
      }).success,
    ).toBe(false);
  });

  it("carries a figure and an absent agent", () => {
    expect(spendPerMergedPr.output.parse(out)).toEqual(out);
  });

  it("refuses a figure beside an absence, and an absence with no reason", () => {
    expect(
      spendPerMergedPr.output.safeParse({
        ...out,
        agents: [{ ...landed, absence: "no_merged_pr" }],
      }).success,
    ).toBe(false);
    expect(
      spendPerMergedPr.output.safeParse({
        ...out,
        agents: [{ ...absent, absence: null }],
      }).success,
    ).toBe(false);
  });

  it("refuses an agent with no bounded run", () => {
    expect(
      spendPerMergedPr.output.safeParse({
        ...out,
        agents: [{ ...landed, boundedRuns: 0 }],
      }).success,
    ).toBe(false);
  });

  it(`lists at most ${SPEND_PER_MERGED_PR_RUNS_MAX} runs under one agent`, () => {
    const runs = Array.from(
      { length: SPEND_PER_MERGED_PR_RUNS_MAX + 1 },
      (_, i) => run(i + 1),
    );
    expect(
      spendPerMergedPr.output.safeParse({
        ...out,
        agents: [{ ...landed, runs }],
      }).success,
    ).toBe(false);
  });
});
