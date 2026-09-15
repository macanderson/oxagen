// onboarding.advance.ts — `advance_onboarding` (#2967).
//
// The operator's two transitions on the gate: `wrap` ↔ `run`. `unlocked` is
// the ingest's alone (lib/onboarding.ts `unlockOnboardingGate`), so asking
// for it is `conflict: first_frame_required`; a gate that is already open
// refuses every transition with `conflict: already_unlocked`; a workspace
// that is not the gate's has no gate to move (`not_found: gate_not_found`).
// Roles: org Owner or Admin (INV-29).
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { onboardingAdvance } from "@oxagen/oxagen/contracts/onboarding.advance";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";

const ONBOARDING_ROLES = ["Owner", "Admin"] as const;

export const onboardingAdvanceHandler: CapabilityHandler<
  typeof onboardingAdvance
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: [...ONBOARDING_ROLES] },
  );
  if (input.to === "unlocked") {
    throw new HandlerError({
      code: "conflict",
      reason: "first_frame_required",
      message:
        "The run step completes only when the first frame arrives; it cannot be skipped",
    });
  }
  const to = input.to;
  const now = new Date();

  return withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        step: schema.onboardingState.step,
        updatedAt: schema.onboardingState.updatedAt,
      })
      .from(schema.onboardingState)
      .where(
        and(
          eq(schema.onboardingState.orgId, ctx.orgId),
          eq(schema.onboardingState.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "gate_not_found",
        message:
          "This workspace is not the organization's onboarding workspace",
      });
    }
    if (row.step === "unlocked") {
      throw new HandlerError({
        code: "conflict",
        reason: "already_unlocked",
        message: "The onboarding gate is already open",
      });
    }
    if (row.step === to) {
      return { step: to, changedAt: row.updatedAt.toISOString() };
    }
    await tx
      .update(schema.onboardingState)
      .set({ step: to, updatedAt: now })
      .where(eq(schema.onboardingState.orgId, ctx.orgId));
    return { step: to, changedAt: now.toISOString() };
  });
};
