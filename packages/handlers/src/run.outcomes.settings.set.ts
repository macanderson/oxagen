import type { CapabilityHandler } from "@oxagen/oxagen";
import { runOutcomesSettingsSet } from "@oxagen/oxagen/contracts/run.outcomes.settings.set";
import { setRunOutcomesConsent } from "@oxagen/plugins/run-outcomes-policy";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { emitSecurityEventAsync } from "@oxagen/database/security";

export const runOutcomesSettingsSetHandler: CapabilityHandler<
  typeof runOutcomesSettingsSet
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  const policy = await setRunOutcomesConsent(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    input.customerEnabled,
    userId as string,
  );
  await emitSecurityEventAsync({
    eventType: "capability.invoke_allowed",
    actorUserId: userId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: runOutcomesSettingsSet.name,
    outcome: "success",
    requestId: ctx.requestId ?? null,
    ip: null,
    userAgent: null,
    detail: {
      feature: "run_outcomes",
      change: "customer_consent",
      enabled: input.customerEnabled,
      reason: null,
    },
  });
  return policy;
};
