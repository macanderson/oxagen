// `dismiss_finding` (ADR-062): close an open finding without applying its
// fix. The findings job cites only runs that start after the dismissal.
//
// Role gate — assertOrgRole: org Owner or Admin (INV-29).
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  findingDismiss,
  type FindingDismissOutput,
} from "@oxagen/oxagen/contracts/finding.dismiss";
import {
  decideFinding,
  findingDecisionDeps,
  type FindingDecisionDeps,
  findingScope,
} from "./finding.shared";

export function createFindingDismissHandler(
  deps: FindingDecisionDeps,
): CapabilityHandler<typeof findingDismiss> {
  return async (input, ctx): Promise<FindingDismissOutput> => {
    // An API key acts as its creator, bounded by the creator's org role.
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    return decideFinding(deps, findingScope(ctx), input.findingId, {
      status: "dismissed",
      decidedByUserId: actingUserId,
      appliedActionId: null,
    });
  };
}

export const findingDismissHandler =
  createFindingDismissHandler(findingDecisionDeps);
