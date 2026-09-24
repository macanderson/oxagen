"use server";
// The Statements section's one call: export_billing_statement on the kernel
// seam (ADR-165). The period is checked here with the form's own rules and
// again by the handler, which also checks the role (org Owner, Admin or
// Billing, INV-29) and is the authority on both.
//
// A CSV page carries at most STATEMENT_PAGE_ROWS ledger rows. The browser asks
// for the next page with the cursor the last one returned and concatenates
// them; the HTML document is one call.
import { billingStatementExport } from "@oxagen/oxagen/contracts/billing.statement.export";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { type StatementForm, statementPeriodInput } from "./statement-period";

/** Ledger rows per CSV page the browser asks for. */
const STATEMENT_PAGE_ROWS = 10_000;

export interface StatementFile {
  filename: string;
  content: string;
  /** csv: rows in this page. */
  lines: number;
  /** csv: pass back for the next page; null on the last. */
  nextCursor: string | null;
}

export async function exportBillingStatementAction(
  org: string,
  form: StatementForm,
  today: string,
  format: "csv" | "html",
  cursor: string | null,
): Promise<ActionResult<StatementFile>> {
  const ctx = await requireViewer(org);
  const period = statementPeriodInput(form, today);
  if (!period.ok)
    return {
      ok: false,
      reason: "invalid",
      code: period.error.code,
      field: period.error.field,
    };
  const result = await kernelWrite(ctx, billingStatementExport, {
    ...period.input,
    format,
    limit: STATEMENT_PAGE_ROWS,
    ...(cursor === null ? {} : { cursor }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          filename: result.value.filename,
          content: result.value.content,
          lines: result.value.lines,
          nextCursor: result.value.nextCursor,
        },
      }
    : result;
}
