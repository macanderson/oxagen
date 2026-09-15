import {
  spendStatementExport,
  STATEMENT_COLUMNS,
} from "@oxagen/oxagen/contracts/spend.statement.export";
import type { DailyTotalsRecord, SpendGroupKind } from "@oxagen/billing";
import { describe, expect, it, vi } from "vitest";
import {
  createSpendStatementHandler,
  csvField,
  monthBounds,
} from "./spend.statement.export";
import type { SpendScope } from "./spend.shared";
import { ctx, daily, OPERATOR, SCOPE } from "./spend.test-support";

function harness(rows: DailyTotalsRecord[]) {
  const readDailyTotals = vi.fn(
    async (
      _scope: SpendScope,
      q: { from: string; to: string; groupKind: SpendGroupKind },
    ) =>
      rows.filter(
        (r) => r.groupKind === q.groupKind && r.day >= q.from && r.day <= q.to,
      ),
  );
  return {
    handler: createSpendStatementHandler({ readDailyTotals }),
    readDailyTotals,
  };
}

describe("monthBounds", () => {
  it("spans the first to the last day of the month, leap years included", () => {
    expect(monthBounds("2026-09")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(monthBounds("2028-02")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(monthBounds("2026-12")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });
});

describe("csvField", () => {
  it("quotes a field with a comma, a quote or a line break and leaves the rest bare", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField(null)).toBe("");
    expect(csvField('a "quoted", key')).toBe('"a ""quoted"", key"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });
});

describe("export_statement", () => {
  it("reads every level for the month in the caller's workspace", async () => {
    const h = harness([]);
    await h.handler({ month: "2026-09", format: "csv" }, ctx());
    for (const level of ["operator", "agent", "model", "tool", "task"])
      expect(h.readDailyTotals).toHaveBeenCalledWith(SCOPE, {
        from: "2026-09-01",
        to: "2026-09-30",
        groupKind: level,
      });
  });

  it("answers the header alone for a month with no rollup", async () => {
    const h = harness([]);
    const out = await h.handler({ month: "2026-09", format: "csv" }, ctx());
    expect(out).toEqual({
      month: "2026-09",
      filename: "spend-statement-2026-09.csv",
      mediaType: "text/csv",
      content: `${STATEMENT_COLUMNS.join(",")}\n`,
      lines: 0,
    });
    expect(() => spendStatementExport.output.parse(out)).not.toThrow();
  });

  it("writes one line per group with cents rounded half to even once, and blanks for what was never priced", async () => {
    const h = harness([
      daily({
        day: "2026-09-03",
        costMicros: 1_234_950n,
        costBasis: "client_attested",
        provenMicros: 500_000n,
        runs: 2,
        calls: 7,
      }),
      daily({
        day: "2026-09-04",
        costMicros: 0n,
        costBasis: "client_attested",
        runs: 1,
        calls: 1,
      }),
      daily({
        groupKind: "model",
        groupKey: "claude-sonnet-5",
        provider: "anthropic",
        costMicros: 25_000n,
        costBasis: "gateway_observed",
      }),
      daily({ groupKind: "tool", groupKey: "Read, write", runs: 3, calls: 9 }),
      daily({ day: "2026-08-31", costMicros: 9n, costBasis: "estimated" }),
    ]);
    const out = await h.handler({ month: "2026-09", format: "csv" }, ctx());
    const [header, ...lines] = out.content.trimEnd().split("\n");
    expect(header).toBe(STATEMENT_COLUMNS.join(","));
    expect(lines).toEqual([
      // 1,234,950 micros = 123.495 cents → 123 (half to even at the line).
      `operator,${OPERATOR},,3,8,1234950,123,USD,client_attested,500000,`,
      // 25,000 micros = 2.5 cents → 2.
      "model,claude-sonnet-5,anthropic,1,4,25000,2,USD,gateway_observed,,",
      'tool,"Read, write",,3,9,,,,,,',
    ]);
    expect(out.lines).toBe(3);
    expect(() => spendStatementExport.output.parse(out)).not.toThrow();
  });
});
