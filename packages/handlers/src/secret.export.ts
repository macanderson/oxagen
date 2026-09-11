import { exportSecrets } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { secretExport } from "@oxagen/oxagen/contracts/secret.export";
import { assertCallerRole } from "./lib/capability-role-guard";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

// Privileged + audited (Spec §7.3). The service writes environments.secret_access_log
// on every call. NEVER log the exported values or rendered .env text.
export const secretExportHandler: CapabilityHandlerFn = async (input, ctx) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.export] workspaceId is required (scoped capability)",
    );
  // The response is every secret in the workspace, in plaintext. The contract
  // restricts that to org Owner/Admin, and the kernel's IAM gate is where that
  // is meant to be enforced — but the gate consults no policy for an org below
  // the tier that unlocks ACLs, so on every other tier a viewer could call this
  // and read the lot (oxagen#2819). Re-read the caller's membership here.
  await assertCallerRole(secretExport, ctx);
  const { environmentId, keyIds } = input as {
    environmentId?: string | null;
    keyIds?: string[] | null;
  };
  try {
    const result = await exportSecrets(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        requestId: ctx.requestId,
      },
      { environmentId: environmentId ?? null, keyIds: keyIds ?? null },
    );
    // Audit the privileged access in the MAIN security log. The service also
    // writes environments.secret_access_log; ADR-050 says why both.
    emitSecurityEvent({
      eventType: "secret.exported",
      actorUserId: ctx.userId ?? null,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: "export_secrets",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        environmentId: environmentId ?? null,
        count: result.env.length,
        actorUserId: ctx.userId,
      },
      "secret.export: ok (recorded to access log)",
    );
    return result;
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        environmentId: environmentId ?? null,
      },
      "secret.export: failed",
    );
    throw err;
  }
};
