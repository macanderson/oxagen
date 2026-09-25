import { deleteEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { environmentDelete } from "@oxagen/oxagen/contracts/environment.delete";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

export const environmentDeleteHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.delete] workspaceId is required (scoped capability)",
    );
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(environmentDelete, ctx);
  const { environmentId } = input as { environmentId: string };
  const result = await deleteEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { environmentId },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, environmentId },
    "environment.delete: ok",
  );
  return result;
};
