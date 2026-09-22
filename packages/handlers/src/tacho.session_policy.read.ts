import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoSessionPolicyRead } from "@oxagen/oxagen/contracts/tacho.session_policy.read";
import { readTachoSessionPolicy } from "./lib/tacho-session-policy";
import { logger } from "./logger";

/**
 * The workspace's policy for wrapped-harness sessions, as a person reads it.
 *
 * The same row `unsignedBundle` signs into the bundle's `budget` and `models`
 * clauses, so what this returns is what a machine will actually apply — minus
 * the per-host reach, which only the write reports.
 */
export const tachoSessionPolicyReadHandler: CapabilityHandler<
  typeof tachoSessionPolicyRead
> = async (_input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "get_tacho_session_policy: rejected — no workspace context",
    );
    throw new Error("get_tacho_session_policy requires a workspace context");
  }
  return readTachoSessionPolicy(ctx.workspaceId);
};
