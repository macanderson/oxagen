// audit-exempt: naming a runtime grants nothing and mints no credential; the agent registered on it next emits agent.registered, and the kernel capability.invoke_* audit covers this call.
//
// runtime.create.ts — name a runtime in this workspace (ADR-192, #4369).
//
// Role gate: the contract's roles, org Owner or Admin (INV-29), for the
// signed-in user or the creator of the API key. The slug is the caller's or
// `slugFromName(name)`, and a slug another live runtime holds is refused with
// `conflict`, reason `runtime_slug_taken`, whether the read sees it first or
// the index catches a race.
import { isUniqueViolation, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { runtimeCreate } from "@oxagen/oxagen/contracts/runtime.create";
import {
  RUNTIME_SLUG_MAX,
  slugFromName,
} from "@oxagen/oxagen/contracts/runtime.shared";
import { contractRoleRequirement } from "./lib/capability-role-guard";
import {
  insertRuntime,
  runtimeRefOf,
  runtimeSlugTaken,
  runtimeSlugTakenError,
} from "./lib/runtimes";
import { logger } from "./logger";

export const runtimeCreateHandler: CapabilityHandler<
  typeof runtimeCreate
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    contractRoleRequirement(runtimeCreate),
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const slug = input.slug ?? slugFromName(input.name, RUNTIME_SLUG_MAX);
  if (slug === "") {
    throw new HandlerError({
      code: "conflict",
      reason: "runtime_slug_empty",
      message:
        "The name has no letter or digit to make a slug from. Type a slug.",
    });
  }
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const runtime = await withTenantDb(async (tx) => {
    if (await runtimeSlugTaken(tx, scope, slug)) {
      throw runtimeSlugTakenError(slug);
    }
    try {
      return await insertRuntime(tx, scope, {
        name: input.name,
        slug,
        userId,
      });
    } catch (err) {
      if (isUniqueViolation(err, "runtimes_workspace_slug_uniq")) {
        throw runtimeSlugTakenError(slug);
      }
      throw err;
    }
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runtimeId: runtime.publicId,
    },
    "runtime.create: runtime named",
  );
  return { runtime: runtimeRefOf(runtime) };
};
