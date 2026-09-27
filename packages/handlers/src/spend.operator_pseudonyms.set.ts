// `set_operator_pseudonyms` (spend spec, Operator ranking): an org Owner or
// Admin turns the workspace's operator pseudonyms on or off. The write keeps
// the row's salt, so each operator's pseudonym stays the same across changes.
// Each change writes a security event with the acting person.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { spendOperatorPseudonymsSet } from "@oxagen/oxagen/contracts/spend.operator_pseudonyms.set";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { writePseudonymPolicy } from "./lib/operator-pseudonyms";

export const spendOperatorPseudonymsSetHandler: CapabilityHandler<
  typeof spendOperatorPseudonymsSet
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  const result = await writePseudonymPolicy(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    input.enabled,
    userId as string,
  );
  await emitSecurityEventAsync({
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
};
