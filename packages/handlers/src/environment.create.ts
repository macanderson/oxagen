import { createEnvironment } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { environmentCreate } from "@oxagen/oxagen/contracts/environment.create";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

export const environmentCreateHandler: CapabilityHandlerFn = async (
  input,
  ctx,
) => {
  if (!ctx.workspaceId)
    throw new Error(
      "[environment.create] workspaceId is required (scoped capability)",
    );
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(environmentCreate, ctx);
  const { name, slug, description } = input as {
    name: string;
    slug: string;
    description?: string | null;
  };
  const environment = await createEnvironment(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId: ctx.userId },
    { name, slug, description: description ?? null },
  );
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      environmentId: environment.id,
    },
    "environment.create: ok",
  );
  return { environment };
};
