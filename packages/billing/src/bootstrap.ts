/**
 * bootstrap.ts — wire the billing admission gate into the AI kernel.
 *
 * The kernel (`@oxagen/oxagen/kernel`) refuses to import `@oxagen/billing`
 * directly (vendor-neutral, no cycle), so it exposes an injection slot. Every
 * service surface (api, app, mcp) calls `bootstrapBillingRuntime()` once at
 * startup — the same pattern as `bootstrapIAMRuntime()` — so that EVERY
 * scoped, non-`noBillingGate` `contract.invoke()` runs
 * `assertGauAvailable(orgId)` before the handler does. Without this call the
 * gate is dormant and suspended or exhausted orgs could still consume.
 * Idempotent.
 *
 * `assertCanStartTurn`, the credit-balance gate, survives only inside the
 * ADR-053 platform-funded assistant turn (turn-credit-gate.ts).
 */

import {
  setBillingAdmissionGate,
  setBudgetAdmissionGate,
  setUsageRecorder,
} from "@oxagen/oxagen/kernel";
import { assertGauAvailable } from "./gau-bucket";
import { assertWithinSpendBudget } from "./spend-budget-gate";
import { recordGovernedAction } from "./action-metering";
import { entryFromKernelRecord } from "./gau-ledger";
import { logger } from "./logger";

let booted = false;

export function bootstrapBillingRuntime(): void {
  if (booted) return;
  booted = true;
  // ADR-055: admission is a read of the org's month bucket and billing mode;
  // it never charges (a gate that charges fails open when Stripe is down).
  setBillingAdmissionGate((orgId) => assertGauAvailable(orgId));
  // Hard period-to-date spend ceiling. Fires right after the billing
  // admission gate inside the kernel's tenant scope; denies with
  // BudgetExceededError when an org/workspace ceiling is reached.
  setBudgetAdmissionGate((args) => assertWithinSpendBudget(args));
  // ADR-052: accrual, the sibling of admission. Fires AFTER a successful
  // handler, never before — a gate that also bills is a gate that fails open
  // when billing is down, and a recorder that also admits refuses a call
  // because an append failed. The kernel guarantees this only fires for a
  // top-level, non-`noBillingGate`, successfully-completed invocation.
  setUsageRecorder(async (record) => {
    // The recorder resolves the org's terms, mode and period itself: a caller
    // cannot talk itself onto cheaper terms by claiming them.
    //
    // The whole record goes on the ledger (ADR-165): the workspace, the agent,
    // the operator, the tool call and the dedup key are what let an invoice
    // line be cited down to the action, and what makes a retried tool call
    // bill once. Before the ledger this handed on four fields and logged the
    // rest.
    await recordGovernedAction({
      orgId: record.orgId,
      actions: record.actions,
      capability: record.capability,
      runId: record.runId,
      entry: entryFromKernelRecord(record),
      now: record.occurredAt,
    });
  });
  logger.info(
    {},
    "billing: admission + spend-budget gates and the governed-action recorder wired into kernel.invoke()",
  );
}
