import { revealSecret } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { secretReveal } from "@oxagen/oxagen/contracts/secret.reveal";
import { assertCallerRole } from "./lib/capability-role-guard";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

// Privileged + audited (Spec §7.3). The service writes environments.secret_access_log
// on every call. NEVER log the revealed value.
//
// The contract restricts reveal to org Owner/Admin, and the kernel's IAM gate is
// where that is meant to be enforced — but checkIAM returns tier_gate -> allow
// whenever canAccessACL(tier) is false, which is every org below the enterprise
// tier, so no policy is consulted and defaultRoles is never read (oxagen#2819).
// apps/app is not the limiter, as an earlier version of this comment claimed:
// instrumentation.ts calls bootstrapIAMRuntime with enforced=true.
//
// So the assertion below is the one that runs. Same helper its four siblings
// took, reading the same contract the gate would have.
export const secretRevealHandler: CapabilityHandlerFn = async (input, ctx) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.reveal] workspaceId is required (scoped capability)",
    );
  await assertCallerRole(secretReveal, ctx);
  const { keyId, environmentId } = input as {
    keyId: string;
    environmentId?: string | null;
  };
  try {
    const result = await revealSecret(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        requestId: ctx.requestId,
      },
      { keyId, environmentId: environmentId ?? null },
    );
    // Audit the privileged access in the MAIN security log. The service also
    // writes environments.secret_access_log; ADR-050 says why both.
    emitSecurityEvent({
      eventType: "secret.revealed",
      actorUserId: ctx.userId ?? null,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: "reveal_secret",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        keyId,
        environmentId: environmentId ?? null,
        source: result.source,
        actorUserId: ctx.userId,
      },
      "secret.reveal: ok (recorded to access log)",
    );
    return { key: result.key, value: result.value, source: result.source };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, keyId },
      "secret.reveal: failed",
    );
    throw err;
  }
};
