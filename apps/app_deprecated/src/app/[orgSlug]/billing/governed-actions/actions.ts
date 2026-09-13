"use server";
/**
 * actions.ts — Server Actions for the governed-action meter page.
 *
 * One action: the run → action → price calculator (`preview_action_cost`).
 * It is the only client→server call on the page; the three read capabilities
 * render server-side from `data.ts`.
 *
 * Authorization: `apps/app` does not bootstrap kernel IAM, so `invoke()` from
 * a Server Action skips the role check. The gate is explicit here. It uses
 * `getOrgRole` + `BILLING_MANAGER_ROLES` rather than `assertBillingManager`
 * because that helper answers with `notFound()`, and a `notFound()` thrown out
 * of an action invoked by a client component is an unhandled rejection rather
 * than a designed permission state. Same role set, same decision, rendered
 * instead of thrown.
 */

import { z } from "zod";
import { invoke } from "@oxagen/oxagen";
// Side-effect import binds every handler into the kernel — without it invoke()
// throws "No handler registered".
import "@oxagen/handlers/register";
import { billingActionEstimate } from "@oxagen/oxagen/contracts/billing.action_estimate";
import type { BillingActionEstimateOutput } from "@oxagen/oxagen/contracts/billing.action_estimate";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import { getSession } from "@/lib/session";
import {
  resolveOrg,
  getOrgRole,
  BILLING_MANAGER_ROLES,
} from "@/lib/resolve-org";

/** Sentinel workspaceId for org-only routes (org_only RLS policy class). */
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const NOT_AUTHORIZED =
  "You don't have permission to read billing for this organization.";

/**
 * Mirrors `billingActionEstimateFields` — the same bounds the contract
 * enforces, applied before the round-trip so a typo in the runs field renders
 * a field error instead of a kernel validation throw.
 */
const PreviewSchema = z.object({
  orgSlug: z.string().min(1),
  runsPerYear: z.number().int().positive().max(1_000_000_000),
  runClass: z.enum([
    "qa_lookup",
    "standard_task",
    "multi_step",
    "long_running",
  ]),
  /** Optional measured override; wins over the run class in the handler. */
  actionsPerRun: z.number().positive().max(10_000).optional(),
  tier: z.enum(["free", "build", "scale", "enterprise"]),
});

export type PreviewActionCostInput = z.infer<typeof PreviewSchema>;

export type PreviewActionCostResult =
  | { ok: true; data: BillingActionEstimateOutput }
  | { ok: false; error: string };

/**
 * Quote a projected annual run volume as governed actions and a price.
 *
 * The handler returns the actions-per-run ratio it used and where that ratio
 * came from; both are surfaced by the caller. A quote whose conversion is
 * hidden is a number a buyer cannot check, which is the thing the capability
 * exists to prevent — so this action never trims `assumptions` out of the
 * payload it hands back.
 */
export async function previewActionCostAction(
  input: PreviewActionCostInput,
): Promise<PreviewActionCostResult> {
  const parsed = PreviewSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "Enter a whole number of runs per year (1 or more), and an actions-per-run override of 10,000 or less.",
    };
  }
  const { orgSlug, runsPerYear, runClass, actionsPerRun, tier } = parsed.data;

  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);
  const viewerUserId = session?.user?.id ?? "";
  if (!viewerUserId) return { ok: false, error: NOT_AUTHORIZED };

  const role = await getOrgRole(org.id, viewerUserId);
  if (!role || !BILLING_MANAGER_ROLES.has(role)) {
    logger.warn(
      { orgSlug, userId: viewerUserId, role },
      "billing/governed-actions: preview denied — not a billing manager",
    );
    return { ok: false, error: NOT_AUTHORIZED };
  }

  try {
    const result = await runInTenantScope(
      { orgId: org.id, workspaceId: ORG_ONLY_WS },
      () =>
        invoke(
          billingActionEstimate.name,
          {
            runsPerYear,
            runClass,
            // Omitted rather than sent as undefined: the contract treats
            // "present" as "a measured ratio was supplied", and it reports the
            // difference back to the user as `actionsPerRunSource`.
            ...(actionsPerRun === undefined ? {} : { actionsPerRun }),
            tier,
          },
          {
            orgId: org.id,
            workspaceId: ORG_ONLY_WS,
            userId: viewerUserId,
            apiKeyId: null as string | null,
            requestId: crypto.randomUUID(),
            surface: "app" as const,
            messageId: null as string | null,
          },
          { surface: "agent" },
        ),
    );
    return { ok: true, data: result as BillingActionEstimateOutput };
  } catch (err) {
    logger.error(
      { err, orgSlug, runsPerYear, runClass, tier },
      "billing/governed-actions: preview_action_cost invoke failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "The estimate could not be calculated.",
    };
  }
}
