"use server";
// The calls a person starts from the Spend page: set one scope's spend ceiling
// (set_spend_budget, whose handler admits an org Owner, Admin or Billing
// member, or a workspace Owner or Admin for that workspace's own), build one
// month's statement (export_statement, answered as CSV text in the call), and
// decide a finding — record its fix as applied or dismiss it (#2963, ADR-062
// §2; org Owner or Admin in the handler), state one negotiated rate
// (set_price_entry) and end one (remove_price_entry), both org Owner, Admin or
// Billing in their handlers. Each runs through kernelWrite, the seam's one path
// for a call a person starts from a page; each is noBillingGate (INV-28).
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import { costPriceEntryRemove } from "@oxagen/oxagen/contracts/cost.price_entry.remove";
import { costPriceEntrySet } from "@oxagen/oxagen/contracts/cost.price_entry.set";
import { findingDismiss } from "@oxagen/oxagen/contracts/finding.dismiss";
import { findingFixRecord } from "@oxagen/oxagen/contracts/finding.fix.record";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import {
  BudgetForm,
  type BudgetFormValues,
  isFindingId,
  isStatementMonth,
  PriceEntryForm,
  type PriceEntryFormValues,
  RemovePriceEntryForm,
  type RemovePriceEntryFormValues,
} from "./forms";
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

/**
 * Record that a finding's fix was applied. The fix lives in the agent's own
 * code, harness or tool configuration, which Oxagen does not hold, so the
 * write records the change against the finding with this call's request id;
 * later detector passes cite only runs that start afterwards (ADR-062 §2).
 */
export async function recordFindingFixAction(
  at: SpendAt,
  findingId: string,
): Promise<ActionResult<null>> {
  const ctx = await requireViewer(at.org, at.ws);
  if (!isFindingId(findingId)) {
    return {
      ok: false,
      reason: "invalid",
      code: "findingInvalid",
      field: "findingId",
    };
  }
  const result = await kernelWrite(ctx, findingFixRecord, { findingId });
  return result.ok ? { ok: true, value: null } : result;
}

/** Close a finding without applying its fix; it keeps its evidence and the decision. */
export async function dismissFindingAction(
  at: SpendAt,
  findingId: string,
): Promise<ActionResult<null>> {
  const ctx = await requireViewer(at.org, at.ws);
  if (!isFindingId(findingId)) {
    return {
      ok: false,
      reason: "invalid",
      code: "findingInvalid",
      field: "findingId",
    };
  }
  const result = await kernelWrite(ctx, findingDismiss, { findingId });
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

/**
 * State this organization's negotiated rate for ONE model and token class.
 *
 * One class per call, because that is what the capability takes and why: the
 * store holds one effective-dated row per (provider, model, class, region), so
 * a four-class rate card is four statements and a failure after the second
 * would otherwise leave the organization priced at a blend nobody agreed to.
 * The sequence, and the record of which classes it wrote before it stopped,
 * belongs to the caller — here the price dialog, which shows both lists rather
 * than reporting a partial write as a success.
 */
export async function setPriceEntryAction(
  at: SpendAt,
  values: PriceEntryFormValues,
): Promise<ActionResult<null>> {
  const ctx = await requireViewer(at.org, at.ws);
  const parsed = PriceEntryForm.safeParse(values);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      ok: false,
      reason: "invalid",
      code: issue?.message ?? "invalid_input",
      field: issue?.path.map(String).join(".") ?? "",
    };
  }
  const result = await kernelWrite(ctx, costPriceEntrySet, parsed.data);
  return result.ok ? { ok: true, value: null } : result;
}

/**
 * End this organization's negotiated rate for one model and token class, so
 * every frame from now on is priced at the provider's list price again. The
 * row is closed and kept, never deleted: a run priced before this instant
 * still names the entry it was priced with.
 */
export async function removePriceEntryAction(
  at: SpendAt,
  values: RemovePriceEntryFormValues,
): Promise<ActionResult<null>> {
  const ctx = await requireViewer(at.org, at.ws);
  const parsed = RemovePriceEntryForm.safeParse(values);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      ok: false,
      reason: "invalid",
      code: issue?.message ?? "invalid_input",
      field: issue?.path.map(String).join(".") ?? "",
    };
  }
  const result = await kernelWrite(ctx, costPriceEntryRemove, parsed.data);
  return result.ok ? { ok: true, value: null } : result;
}
