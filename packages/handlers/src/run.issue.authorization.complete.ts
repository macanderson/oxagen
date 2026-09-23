import type { CapabilityHandler } from "@oxagen/oxagen";
import { runIssueAuthorizationComplete } from "@oxagen/oxagen/contracts/run.issue.authorization.complete";
import { completeLinearAuthorization } from "@oxagen/plugins/run-outcomes-linear";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { emitSecurityEventAsync } from "@oxagen/database/security";

export const handler: CapabilityHandler<
  typeof runIssueAuthorizationComplete
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  if (!userId)
    throw new HandlerError({
      code: "forbidden",
      reason: "human_authorization_required",
    });
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await completeLinearAuthorization(
    scope,
    userId,
    input.state,
    input.code,
  );

  await emitSecurityEventAsync({
    eventType: "plugin.credential_set",
    actorUserId: userId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: runIssueAuthorizationComplete.name,
    outcome: "success",
    requestId: ctx.requestId ?? null,
    ip: null,
    userAgent: null,
    detail: {
      feature: "run_outcomes",
      provider: "linear",
      connectionId: result.connectionId,
    },
  });

  return result;
};
