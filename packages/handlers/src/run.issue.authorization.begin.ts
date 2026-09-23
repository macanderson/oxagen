import type { CapabilityHandler } from "@oxagen/oxagen";
import { runIssueAuthorizationBegin } from "@oxagen/oxagen/contracts/run.issue.authorization.begin";
import { beginLinearAuthorization } from "@oxagen/plugins/run-outcomes-linear";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen/handler-error";

export const handler: CapabilityHandler<
  typeof runIssueAuthorizationBegin
> = async (_input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  if (!userId)
    throw new HandlerError({
      code: "forbidden",
      reason: "human_authorization_required",
    });
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await beginLinearAuthorization(scope, userId);

  return result;
};
