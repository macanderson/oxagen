import { describe, expect, it } from "vitest";
import { spendStatementExport } from "./spend.statement.export";

describe("export_statement contract", () => {
  it("takes a calendar month and answers CSV only", () => {
    expect(spendStatementExport.noBillingGate).toBe(true);
    expect(spendStatementExport.mutates).toBe(false);
    expect(spendStatementExport.input.parse({ month: "2026-09" })).toEqual({
      month: "2026-09",
      format: "csv",
    });
    expect(
      spendStatementExport.input.safeParse({ month: "2026-13" }).success,
    ).toBe(false);
    expect(
      spendStatementExport.input.safeParse({ month: "2026-09", format: "pdf" })
        .success,
    ).toBe(false);
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
