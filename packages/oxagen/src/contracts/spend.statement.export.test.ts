import { describe, expect, it } from "vitest";
import {
  RUN_STATEMENT_COLUMNS,
  spendStatementExport,
} from "./spend.statement.export";

describe("export_statement contract", () => {
  it("takes a calendar month and answers CSV only", () => {
    expect(spendStatementExport.noBillingGate).toBe(true);
    expect(spendStatementExport.mutates).toBe(false);
    expect(spendStatementExport.input.parse({ month: "2026-09" })).toEqual({
      month: "2026-09",
      format: "csv",
      rows: "groups",
    });
    expect(
      spendStatementExport.input.safeParse({ month: "2026-13" }).success,
    ).toBe(false);
    expect(
      spendStatementExport.input.safeParse({ month: "2026-09", format: "pdf" })
        .success,
    ).toBe(false);
  });

  it("takes one line per run on request and no other kind of line (#2962)", () => {
    expect(
      spendStatementExport.input.parse({ month: "2026-09", rows: "runs" }),
    ).toEqual({ month: "2026-09", format: "csv", rows: "runs" });
    expect(
      spendStatementExport.input.safeParse({ month: "2026-09", rows: "days" })
        .success,
    ).toBe(false);
    expect(RUN_STATEMENT_COLUMNS).toEqual([
      "line",
      "run_id",
      "started_at",
      "sealed_at",
      "agent",
      "operator_key",
      "operator",
      "work_item",
      "work_item_title",
      "runs",
      "cost_micros",
      "cost_cents",
      "currency",
      "basis",
    ]);
  });

  it("answers the statement text with its media type and line count", () => {
    const out = {
      month: "2026-09",
      filename: "spend-statement-2026-09.csv",
      mediaType: "text/csv",
      content: "level,key\n",
      lines: 0,
    };
    expect(spendStatementExport.output.parse(out)).toEqual(out);
    expect(
      spendStatementExport.output.safeParse({
        ...out,
        mediaType: "application/pdf",
      }).success,
    ).toBe(false);
  });
});
