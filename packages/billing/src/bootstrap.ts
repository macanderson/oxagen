/**
 * bootstrap.ts — wire the billing admission gate into the AI kernel.
 *
 * The kernel (`@oxagen/oxagen/kernel`) refuses to import `@oxagen/billing`
 * directly (vendor-neutral, no cycle), so it exposes an injection slot. Every
 * service surface (api, app, mcp) calls `bootstrapBillingRuntime()` once at
 * startup — the same pattern as `bootstrapIAMRuntime()` — so that EVERY
 * `contract.invoke()` runs `assertCanStartTurn(orgId)` before the model does.
 * Without this call the gate is dormant and suspended / zero-balance orgs could
 * still consume. Idempotent.
 */

import {
  setBillingAdmissionGate,
  setBudgetAdmissionGate,
  setUsageRecorder,
} from "@oxagen/oxagen/kernel";
import { assertCanStartTurn } from "./metering";
import { assertWithinSpendBudget } from "./spend-budget-gate";
import { recordGovernedAction } from "./action-metering";
import { resolveOrgActionEntitlement } from "./plan-allowance";
import { logger } from "./logger";

let booted = false;

export function bootstrapBillingRuntime(): void {
  if (booted) return;
  booted = true;
  setBillingAdmissionGate((orgId) => assertCanStartTurn(orgId));
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
    // One query for tier + stored allowance. Two would be two round trips per
    // governed action for two columns of the same join.
    const entitlement = await resolveOrgActionEntitlement(record.orgId);
    await recordGovernedAction({
      orgId: record.orgId,
      actions: record.actions,
      capability: record.capability,
      tier: entitlement.tier,
      planIncludedActions: entitlement.includedActionsAnnual,
      runId: record.runId,
      now: record.occurredAt,
    });
  });
  logger.info(
    {},
    "billing: admission + spend-budget gates and the governed-action recorder wired into kernel.invoke()",
  );
}
