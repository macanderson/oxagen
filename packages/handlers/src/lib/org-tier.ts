// org-tier.ts — whether the kernel enforces roles for an org (ADR-057).
//
// `checkIAM` runs the resolver only when `canAccessACL(tier)` holds, the
// enterprise tier (packages/iam/src/check-iam.ts; apps/app/ARCHITECTURE.md
// §1.5). The roles read reports the fact; the role editor refuses to write a
// role the kernel would never read.

import { canAccessACL, resolveOrgTier } from "@oxagen/billing";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { PlanTier } from "@oxagen/oxagen/types";

export interface RoleEnforcement {
  readonly tier: PlanTier;
  readonly enforced: boolean;
}

export async function roleEnforcementOf(
  ctx: Pick<CapabilityContext, "orgId" | "planTier">,
): Promise<RoleEnforcement> {
  const tier = ctx.planTier ?? (await resolveOrgTier(ctx.orgId));
  return { tier, enforced: canAccessACL(tier) };
}
