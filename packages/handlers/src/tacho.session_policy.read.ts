import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoSessionPolicyRead } from "@oxagen/oxagen/contracts/tacho.session_policy.read";
import { readTachoSessionPolicy } from "./lib/tacho-session-policy";
import { logger } from "./logger";

/**
 * The workspace's policy for wrapped-harness sessions, as a person reads it.
 *
 * Nothing applies this row yet. `unsignedBundle` (`lib/tacho-host.ts`) signs
 * no `models` clause, and the bundle's budget comes from the agent's mandate,
 * not from here. What this returns is the decision the workspace recorded,
 * and the per-host reach is reported by the write alone.
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
