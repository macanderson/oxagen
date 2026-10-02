import { describe, expect, it } from "vitest";
import {
  OPERATOR_RANKING_RUNS_MAX,
  spendOperatorRanking,
} from "./spend.operator_ranking";

const usd = (micros: string) => ({ micros, currency: "USD" });

const named = {
  rank: 1,
  operator: {
    kind: "named",
    key: "prn_ada",
    facts: {
      id: "prn_ada",
      name: "Ada",
      email: "ada@example.com",
      avatarUrl: null,
      role: "Member",
    },
  },
  unproductive: usd("700"),
  shareOfTotal: 0.7,
  unproductiveShare: 0.1,
  runs: 2,
  topRuns: [
    { runId: "arun_1", unproductive: usd("500") },
    { runId: "tse_2", unproductive: usd("200") },
  ],
  doneWorkOrders: 1,
  topDoneWorkOrders: [
    {
      workOrderId: "wo_1",
      doneAt: "2026-09-12T10:00:00.000Z",
      runs: ["arun_1"],
    },
  ],
  unassignedShare: 0.25,
  topUnassignedRuns: [{ runId: "tse_2", unassigned: usd("50") }],
};

const out = {
  period: { from: "2026-09-01", to: "2026-09-30" },
  pseudonyms: false,
  unproductive: usd("1000"),
  unattributed: { unproductive: usd("300"), runs: 1 },
  operators: [named],
};

describe("get_operator_ranking contract", () => {
  it("is a manager read over a day range", () => {
    expect(spendOperatorRanking.mutates).toBe(false);
    expect(spendOperatorRanking.noBillingGate).toBe(true);
    expect(spendOperatorRanking.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(
      spendOperatorRanking.input.safeParse({
        period: { from: "2026-09-01", to: "2026-09-30" },
      }).success,
    ).toBe(true);
    expect(spendOperatorRanking.input.safeParse({}).success).toBe(false);
  });

  it("carries a named row with its runs", () => {
    expect(spendOperatorRanking.output.parse(out)).toEqual(out);
  });

  it("carries a pseudonym row with no key, no facts, and no runs", () => {
    const row = {
      ...named,
      operator: { kind: "pseudonym", pseudonym: "Operator 0A1B2C3D" },
      unproductiveShare: null,
      runs: null,
      topRuns: [],
      topDoneWorkOrders: [],
      unassignedShare: null,
      topUnassignedRuns: [],
    };
    const parsed = spendOperatorRanking.output.parse({
      ...out,
      pseudonyms: true,
      operators: [row],
    }).operators[0];
    expect(parsed?.operator).toEqual({
      kind: "pseudonym",
      pseudonym: "Operator 0A1B2C3D",
    });
    expect(parsed?.runs).toBeNull();
    expect(parsed?.unproductiveShare).toBeNull();
    expect(
      spendOperatorRanking.output.safeParse({
        ...out,
        operators: [
          { ...row, operator: { ...row.operator, key: "prn_ada" } },
        ],
      }).success,
    ).toBe(false);
    expect(
      spendOperatorRanking.output.safeParse({
        ...out,
        operators: [
          { ...row, operator: { kind: "pseudonym", pseudonym: "Ada" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("carries the done work orders and the unassigned share beside each name", () => {
    const parsed = spendOperatorRanking.output.parse(out).operators[0];
    expect(parsed?.doneWorkOrders).toBe(1);
    expect(parsed?.topDoneWorkOrders[0]?.workOrderId).toBe("wo_1");
    expect(parsed?.unassignedShare).toBe(0.25);
    expect(
      spendOperatorRanking.output.safeParse({
        ...out,
        operators: [{ ...named, unassignedShare: 1.5 }],
      }).success,
    ).toBe(false);
    expect(
      spendOperatorRanking.output.safeParse({
        ...out,
        operators: [{ ...named, doneWorkOrders: -1 }],
      }).success,
    ).toBe(false);
    // A work order is cited by its public id, never its uuid.
    expect(
      spendOperatorRanking.output.safeParse({
        ...out,
        operators: [
          {
            ...named,
            topDoneWorkOrders: [
              {
                workOrderId: "0192d4a8-7c1e-7a00-8000-000000000001",
                doneAt: "2026-09-12T10:00:00.000Z",
                runs: [],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses a share above 1 and too many cited runs", () => {
    expect(
      spendOperatorRanking.output.safeParse({
        ...out,
        operators: [{ ...named, shareOfTotal: 1.2 }],
      }).success,
    ).toBe(false);
    expect(
      spendOperatorRanking.output.safeParse({
        ...out,
        operators: [
          {
            ...named,
            topRuns: Array.from(
              { length: OPERATOR_RANKING_RUNS_MAX + 1 },
              () => ({ runId: "arun_1", unproductive: usd("1") }),
            ),
          },
        ],
      }).success,
    ).toBe(false);
  });
});
