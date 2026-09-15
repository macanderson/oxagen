import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingBudgetSet } from "@oxagen/oxagen/contracts/billing.budget.set";
import { parseMicros } from "@oxagen/oxagen/contracts/spend.shared";
import {
  getSpendBudget,
  getSpendBudgetStatuses,
  invalidateSpendBudgetScope,
  setSpendBudget,
} from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";
import { toSpendBudgetDto } from "./lib/spend-budget-dto";

/**
 * set_spend_budget — create or replace one scope's hard spend ceiling. Raising a
 * ceiling is the org-admin override that clears a `budget_exceeded` denial; the
 * kernel audit chain records it (IAM-gated on the api/mcp surface; the app panel
 * adds an explicit billing-manager gate since apps/app skips kernel IAM).
 *
 * After the write we drop the org's cached config + spend (best-effort,
 * per-process) so a raised ceiling takes effect immediately rather than after
 * the gate's short TTL, then re-read the saved scope's live status to return.
 */
export const billingBudgetSetHandler: CapabilityHandler<
  typeof billingBudgetSet
> = async (input, ctx) => {
  const workspaceId = input.scope === "workspace" ? ctx.workspaceId : null;

  // Read the current ceiling first so the audit row can carry previous → new.
  const previous = await getSpendBudget({ workspaceId });

  await setSpendBudget({
    orgId: ctx.orgId,
    workspaceId,
    enabled: input.enabled,
    period: input.period,
    windowDays: input.period === "rolling" ? (input.windowDays ?? null) : null,
    limitMicros: parseMicros(input.limit.micros),
    actorUserId: ctx.userId,
  });

  // ── Emit audit event (fire-and-forget; must not fail the capability) ──────
  // SOC2 CC6.3/CC6.8: setting a spending limit is exactly the privileged state
  // change audit trails exist for. The structured log carries previous → new
  // so an auditor can reconstruct the change; the security_events row is the
  // tamper-evident marker that it happened, by whom, and where.
  emitSecurityEvent({
    eventType: "billing.budget_updated",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId,
    capability: "set_spend_budget",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      actorUserId: ctx.userId,
      scope: input.scope,
      workspaceId,
      previousLimitMicros: previous ? String(previous.limitMicros) : null,
      newLimitMicros: input.limit.micros,
      previousEnabled: previous?.enabled ?? null,
      newEnabled: input.enabled,
      previousPeriod: previous?.period ?? null,
      newPeriod: input.period,
      surface: ctx.surface,
    },
    "billing.budget.set: spend ceiling updated",
  );

  // Clear the (short-TTL) gate cache so the new ceiling is live at once.
  invalidateSpendBudgetScope({ orgId: ctx.orgId });

  // Re-read the saved scope's live status (fresh spend) for the panel.
  const statuses = await getSpendBudgetStatuses();
  const saved = statuses.find((s) => s.budget.scope === input.scope);
  if (!saved) {
    throw new Error(
      `set_spend_budget: saved ${input.scope} ceiling not found on read-back`,
    );
  }
  return toSpendBudgetDto(saved);
};
