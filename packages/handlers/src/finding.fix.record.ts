// `record_finding_fix` (ADR-062 §2): record that an open finding's fix was
// applied. The finding becomes `applied` with the request id of this
// invocation, the key its audit row carries, and the findings job cites only
// runs that start afterwards.
//
// Role gate — assertOrgRole: org Owner or Admin. The kernel's IAM check
// allows every capability for a non-enterprise org, so the handler checks
// (INV-29).
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  findingFixRecord,
  type FindingFixRecordOutput,
} from "@oxagen/oxagen/contracts/finding.fix.record";
import {
  decideFinding,
  findingDecisionDeps,
  type FindingDecisionDeps,
  findingScope,
} from "./finding.shared";

export function createFindingFixRecordHandler(
  deps: FindingDecisionDeps,
): CapabilityHandler<typeof findingFixRecord> {
  return async (input, ctx): Promise<FindingFixRecordOutput> => {
    // An API key acts as its creator, bounded by the creator's org role.
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    return decideFinding(deps, findingScope(ctx), input.findingId, {
      status: "applied",
      decidedByUserId: actingUserId,
      appliedActionId: ctx.requestId,
    });
  };
}

export const findingFixRecordHandler =
  createFindingFixRecordHandler(findingDecisionDeps);
