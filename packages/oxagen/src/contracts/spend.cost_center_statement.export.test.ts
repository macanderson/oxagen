import { describe, expect, it } from "vitest";
import { spendCostCenterStatementExport } from "./spend.cost_center_statement.export";

describe("export_cost_center_statement contract", () => {
  it("is an organization-wide read of one month as CSV", () => {
    expect(spendCostCenterStatementExport.scoped).toBe(false);
    expect(spendCostCenterStatementExport.mutates).toBe(false);
    expect(
      spendCostCenterStatementExport.input.parse({ month: "2026-09" }),
    ).toEqual({ month: "2026-09", format: "csv" });
    expect(
      spendCostCenterStatementExport.input.safeParse({ month: "2026-9" })
        .success,
    ).toBe(false);
  });

  it("answers lines with their run ids and a total", () => {
    const cost = { micros: "1000", currency: "USD", basis: "mixed" };
    const out = {
      month: "2026-09",
      filename: "cost-center-statement-2026-09.csv",
      mediaType: "text/csv",
      content: "line\n",
      lines: [
        {
          costCenter: "~none",
          runs: 1,
          unpricedRuns: 0,
          cost,
          runIds: ["tse_1"],
        },
      ],
      total: { runs: 1, unpricedRuns: 0, cost },
    };
    expect(spendCostCenterStatementExport.output.parse(out)).toEqual(out);
  });
});
