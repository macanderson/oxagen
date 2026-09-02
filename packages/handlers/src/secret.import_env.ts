import { importEnv } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

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
