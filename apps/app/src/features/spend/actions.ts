"use server";
// The calls a person starts from the Spend page: set one scope's spend ceiling
// (set_spend_budget, whose handler admits an org Owner, Admin or Billing
// member, or a workspace Owner or Admin for that workspace's own), build one
// month's statement (export_statement, answered as CSV text in the call) or
// the organization's chargeback statement by cost center
// (export_cost_center_statement, org Owner, Admin or Billing; ADR-142), and
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
import { spendCostCenterStatementExport } from "@oxagen/oxagen/contracts/spend.cost_center_statement.export";
import { spendStatementExport } from "@oxagen/oxagen/contracts/spend.statement.export";
import { tachoSessionPolicyWrite } from "@oxagen/oxagen/contracts/tacho.session_policy.write";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import {
  BudgetForm,
  type BudgetFormValues,
  GatewayPolicyForm,
  type GatewayPolicyFormValues,
  isFindingId,
  isStatementMonth,
  PriceEntryForm,
  type PriceEntryFormValues,
  RemovePriceEntryForm,
  type RemovePriceEntryFormValues,
} from "./forms";
import type { GatewayReach, SpendAt } from "./view";

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
 * Set what the loopback gateway refuses for a wrapped Claude Code or Codex
 * session in this workspace (`update_tacho_session_policy`, Owner or Admin in
 * the handler).
 *
 * The reach comes back with the saved policy and the section renders it,
 * because a model list rides a gated bundle field: a host too old to parse it
 * is never sent one and keeps calling whatever it likes. Returning only "saved"
 * would report a policy that governs no machine as a policy in force.
 */
export async function setGatewayPolicyAction(
  at: SpendAt,
  values: GatewayPolicyFormValues,
): Promise<ActionResult<GatewayReach>> {
  const ctx = await requireViewer(at.org, at.ws);
  const parsed = GatewayPolicyForm.safeParse(values);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    return {
      ok: false,
      reason: "invalid",
      code: issue?.message ?? "invalid_input",
      field: issue?.path.map(String).join(".") ?? "",
    };
  }
  const result = await kernelWrite(ctx, tachoSessionPolicyWrite, parsed.data);
  return result.ok ? { ok: true, value: result.value.reach } : result;
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
 * The organization's chargeback statement for one month: one line per cost
 * center with its run ids. Organization-wide, so it runs in the organization
 * viewer's context rather than the workspace's.
 */
export async function exportCostCenterStatementAction(
  at: SpendAt,
  month: string,
): Promise<ActionResult<{ filename: string; content: string }>> {
  const ctx = await requireViewer(at.org);
  if (!isStatementMonth(month)) {
    return {
      ok: false,
      reason: "invalid",
      code: "monthInvalid",
      field: "month",
    };
  }
  const result = await kernelWrite(ctx, spendCostCenterStatementExport, {
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

/** State this model's negotiated card in one kernel call and transaction. */
export async function setPriceEntryAction(
  at: SpendAt,
  values: PriceEntryFormValues,
  additionalValues: PriceEntryFormValues[] = [],
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
  const additionalRates = [];
  for (const values of additionalValues) {
    const next = PriceEntryForm.safeParse(values);
    if (
      !next.success ||
      next.data.provider !== parsed.data.provider ||
      next.data.model !== parsed.data.model ||
      next.data.effectiveFrom !== parsed.data.effectiveFrom
    ) {
      return {
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "rates",
      };
    }
    additionalRates.push({
      tokenClass: next.data.tokenClass,
      usdPerMillion: next.data.usdPerMillion,
    });
  }
  const result = await kernelWrite(ctx, costPriceEntrySet, {
    ...parsed.data,
    ...(additionalRates.length > 0 ? { additionalRates } : {}),
  });
  return result.ok ? { ok: true, value: null } : result;
}

/**
 * End this organization's negotiated rate for one model and token class.
 * From now on every frame resolves to a list or override price WHEN ONE
 * EXISTS — `fallbackPriced` in the value says whether it does, because a
 * model this organization negotiated alone has no such row, and the dialog
 * must not claim a fallback that is not there. The row is closed and kept,
 * never deleted: a run priced before this instant still names the entry it
 * was priced with.
 *
 * The handler checks for that fallback BEFORE it closes anything: without
 * `confirmUnpriced` it refuses a close that would leave the class unpriced
 * (`conflict` / `price_entry_close_would_unprice`) rather than close first
 * and report the gap here afterward. `values.confirmUnpriced` is the
 * dialog's second submit, once the person has seen that refusal and chosen
 * to proceed anyway.
 */
export async function removePriceEntryAction(
  at: SpendAt,
  values: RemovePriceEntryFormValues,
): Promise<ActionResult<{ fallbackPriced: boolean }>> {
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
  return result.ok
    ? { ok: true, value: { fallbackPriced: result.value.fallbackPriced } }
    : result;
}
