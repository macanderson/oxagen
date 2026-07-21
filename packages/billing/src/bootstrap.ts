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
} from "@oxagen/oxagen/kernel";
import { assertCanStartTurn } from "./metering";
import { assertWithinSpendBudget } from "./spend-budget-gate";
import { logger } from "./logger";

let booted = false;

export function bootstrapBillingRuntime(): void {
  if (booted) return;
  booted = true;
  setBillingAdmissionGate((orgId) => assertCanStartTurn(orgId));
  // Hard period-to-date spend ceiling (OXA-1079). Fires right after the billing
  // admission gate inside the kernel's tenant scope; denies with
  // BudgetExceededError when an org/workspace ceiling is reached.
  setBudgetAdmissionGate((args) => assertWithinSpendBudget(args));
  logger.info(
    {},
    "billing: admission + spend-budget gates wired into kernel.invoke()",
  );
}
