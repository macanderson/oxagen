import { describe, expect, it } from "vitest";
import {
  billingStatementExport,
  STATEMENT_CSV_PAGE_DEFAULT,
  STATEMENT_CSV_PAGE_MAX,
  STATEMENT_LINE_ITEM_COLUMNS,
} from "./billing.statement.export";

describe("export_billing_statement contract", () => {
  it("exports CSV by default in pages of 10,000 rows, at most 50,000", () => {
    expect(
      billingStatementExport.input.parse({
        period: "year",
        anchor: "2026-01-01",
      }),
    ).toEqual({
      period: "year",
      anchor: "2026-01-01",
      format: "csv",
      limit: STATEMENT_CSV_PAGE_DEFAULT,
    });
    expect(STATEMENT_CSV_PAGE_DEFAULT).toBe(10_000);
    expect(
      billingStatementExport.input.safeParse({
        period: "year",
        anchor: "2026-01-01",
        limit: STATEMENT_CSV_PAGE_MAX + 1,
      }).success,
    ).toBe(false);
    expect(
      billingStatementExport.input.safeParse({
        period: "year",
        anchor: "2026-01-01",
        format: "pdf",
      }).success,
    ).toBe(false);
  });
  it("names every ledger attribution column once", () => {
    expect(new Set(STATEMENT_LINE_ITEM_COLUMNS).size).toBe(
      STATEMENT_LINE_ITEM_COLUMNS.length,
    );
    for (const c of [
      "billed_at",
      "occurred_at",
      "agent",
      "operator",
      "tool_call_id",
      "units",
    ])
      expect(STATEMENT_LINE_ITEM_COLUMNS).toContain(c);
  });
  it("answers a file with its media type, or the next cursor", () => {
    expect(
      billingStatementExport.output.safeParse({
        reference: "ST-1-20260901-20260930",
        format: "csv",
        filename: "ST-1-20260901-20260930.csv",
        mediaType: "text/csv",
        content: "a,b\r\n",
        lines: 1,
        nextCursor: "abc",
      }).success,
    ).toBe(true);
  });
});
