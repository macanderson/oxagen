"use server";
// The Spend page's two calls a person starts (#2962): set one scope's spend
// ceiling (set_spend_budget, whose handler admits an org Owner, Admin or
// Billing member, or a workspace Owner or Admin for that workspace's own) and
// build one month's statement (export_statement, answered as CSV text in the
// call). Both run through kernelWrite, the seam's one path for a call a
// person starts from a page; both are noBillingGate (INV-28).
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { BudgetForm, type BudgetFormValues, isStatementMonth } from "./forms";
import type { SpendAt } from "./view";

/** A field the form refuses is `invalid` with the field and its catalog key, and no capability runs. */
export async function setBudgetAction(
  at: SpendAt,
  values: BudgetFormValues,
): Promise<ActionResult<null>> {
  const ctx = await requireViewer(at.org, at.ws);
  const parsed = BudgetForm.safeParse(values);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      ok: false,
      reason: "invalid",
      code: issue?.message ?? "invalid_input",
      field: issue?.path.map(String).join(".") ?? "",
    };
  }
  const result = await kernelWrite(ctx, billingBudgetSet, parsed.data);
  return result.ok ? { ok: true, value: null } : result;
}

export async function exportStatementAction(
  at: SpendAt,
  month: string,
): Promise<ActionResult<{ filename: string; content: string }>> {
  const ctx = await requireViewer(at.org, at.ws);
  if (!isStatementMonth(month)) {
    return {
      ok: false,
      reason: "invalid",
      code: "monthInvalid",
      field: "month",
    };
  }
  const result = await kernelWrite(ctx, spendStatementExport, {
    month,
    format: "csv",
  });
  return result.ok
    ? {
        ok: true,
        value: {
          filename: result.value.filename,
          content: result.value.content,
        },
      }
    : result;
}
