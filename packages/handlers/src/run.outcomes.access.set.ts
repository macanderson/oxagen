import { randomUUID } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { runOutcomesAccessSet } from "@oxagen/oxagen/contracts/run.outcomes.access.set";
import { setRunOutcomesPlatformAccess } from "@oxagen/plugins/run-outcomes-policy";
import { emitSecurityEventAsync } from "@oxagen/database/security";

export const runOutcomesAccessSetHandler: CapabilityHandler<
  typeof runOutcomesAccessSet
> = async (input, ctx) => {
  const requestId = ctx.requestId ?? randomUUID();
  const policy = await setRunOutcomesPlatformAccess({ ...input, requestId });
  // Awaited because the trusted operator script exits after this invocation.
  await emitSecurityEventAsync({
    eventType: "capability.invoke_allowed",
    actorUserId: null,
    orgId: input.orgId,
    workspaceId: null,
    capability: runOutcomesAccessSet.name,
    outcome: "success",
    requestId,
    ip: null,
    userAgent: null,
    detail: {
      feature: "run_outcomes",
      change: "platform_access",
      enabled: !input.disabled,
      reason: input.reason,
    },
  });
  return policy;
};
