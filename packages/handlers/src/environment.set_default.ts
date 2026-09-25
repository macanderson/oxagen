import { setDefaultEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { environmentSetDefault } from "@oxagen/oxagen/contracts/environment.set_default";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

export const environmentSetDefaultHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.set_default] workspaceId is required (scoped capability)",
    );
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(environmentSetDefault, ctx);
  const { environmentId } = input as { environmentId: string };
  const environment = await setDefaultEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { environmentId },
  );
  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, environmentId },
    "environment.set_default: ok",
  );
  return { environment };
};
