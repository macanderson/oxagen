import { importEnv } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

export const secretImportEnvHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[secret.import_env] workspaceId is required (scoped capability)",
    );
  const { text, environmentId, commit } = input as {
    text: string;
    environmentId?: string | null;
    commit: boolean;
  };
  const result = await importEnv(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { text, environmentId: environmentId ?? null, commit },
  );
  // A dry run parses and writes nothing, so it is not a secret change and does
  // not get a row. Emitting unconditionally would put an audit entry against a
  // preview -- the shape oxagen#2530 warns a shallow coverage check cannot see.
  if (result.committed) {
    emitSecurityEvent({
      eventType: "secret.value_changed",
      actorUserId: ctx.userId ?? null,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: "import_env_secrets",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
  }
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      environmentId: environmentId ?? null,
      parsed: result.rows.length,
      committed: result.committed,
    },
    "secret.import_env: ok",
  );
  return result;
};
