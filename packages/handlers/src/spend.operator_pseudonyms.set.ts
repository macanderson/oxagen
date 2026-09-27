// `set_operator_pseudonyms` (spend spec, Operator ranking): an org Owner or
// Admin turns the workspace's operator pseudonyms on or off. The write keeps
// the row's salt, so each operator's pseudonym stays the same across changes.
// The setting and its security event commit in one transaction, so a change
// with no record of who made it cannot persist.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { spendOperatorPseudonymsSet } from "@oxagen/oxagen/contracts/spend.operator_pseudonyms.set";
import { withTenantDb } from "@oxagen/database";
import { emitSecurityEventIn } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { writePseudonymPolicyIn } from "./lib/operator-pseudonyms";

export const spendOperatorPseudonymsSetHandler: CapabilityHandler<
  typeof spendOperatorPseudonymsSet
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  return withTenantDb(async (tx) => {
    const result = await writePseudonymPolicyIn(
      tx,
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      input.enabled,
      userId as string,
    );
    await emitSecurityEventIn(tx, {
      eventType: "capability.invoke_allowed",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: spendOperatorPseudonymsSet.name,
      outcome: "success",
      requestId: ctx.requestId ?? null,
      ip: null,
      userAgent: null,
      detail: {
        feature: "operator_ranking",
        change: "pseudonyms",
        enabled: input.enabled,
      },
    });
    return result;
  });
};
