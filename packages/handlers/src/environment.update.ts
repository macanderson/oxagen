import { updateEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { environmentUpdate } from "@oxagen/oxagen/contracts/environment.update";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

export const environmentUpdateHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.update] workspaceId is required (scoped capability)",
    );
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(environmentUpdate, ctx);
  const { environmentId, name, slug, description, isActive } = input as {
    environmentId: string;
    name?: string;
    slug?: string;
    description?: string | null;
    isActive?: boolean;
  };
  const environment = await updateEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { environmentId, name, slug, description, isActive },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, environmentId },
    "environment.update: ok",
  );
  return { environment };
};
