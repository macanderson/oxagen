// runtime.update.ts — rename a runtime or change whether it requires the
// contained launcher (ADR-204, #4372).
//
// Role gate: the contract's roles, org Owner or Admin (INV-29), for the
// signed-in user or the creator of the API key, the bar `create_runtime`
// sets. A field the caller leaves out keeps its value. The slug does not
// follow a rename, because enrollments and records name the runtime by it.
//
// The runtime row is locked while it is read and written, so the value
// before a change is the one the change replaced. A change to
// `containmentRequired` writes a `capability.invoke_allowed` security event
// in the same transaction, with the value before and after, so the audit
// row exists exactly when the change does. A call that changes nothing
// writes nothing.
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEventIn } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { runtimeUpdate } from "@oxagen/oxagen/contracts/runtime.update";
import { eq } from "drizzle-orm";
import { contractRoleRequirement } from "./lib/capability-role-guard";
import { requireRuntime, runtimeRefOf } from "./lib/runtimes";
import { logger } from "./logger";

export const runtimeUpdateHandler: CapabilityHandler<
  typeof runtimeUpdate
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    contractRoleRequirement(runtimeUpdate),
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    const before = await requireRuntime(tx, scope, input.runtimeId, {
      forUpdate: true,
    });
    const name = input.name ?? before.name;
    const containmentRequired =
      input.containmentRequired ?? before.containmentRequired;
    const renamed = name !== before.name;
    const containmentChanged =
      containmentRequired !== before.containmentRequired;
    if (!renamed && !containmentChanged) {
      return { runtime: before, containmentChanged: false };
    }

    await tx
      .update(schema.runtimes)
      .set({
        name,
        containmentRequired,
        updatedAt: new Date(),
        updatedById: userId,
      })
      .where(eq(schema.runtimes.id, before.id));

    if (containmentChanged) {
      await emitSecurityEventIn(tx, {
        eventType: "capability.invoke_allowed",
        actorUserId: userId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        capability: runtimeUpdate.name,
        outcome: "success",
        requestId: ctx.requestId ?? null,
        ip: null,
        userAgent: null,
        detail: {
          feature: "runtime_containment",
          change: "containment_required",
          runtimeId: before.publicId,
          previous: before.containmentRequired,
          enabled: containmentRequired,
          reason: null,
        },
      });
    }
    return {
      runtime: { ...before, name, containmentRequired },
      containmentChanged,
    };
  });

  if (result.containmentChanged) {
    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        runtimeId: result.runtime.publicId,
        containmentRequired: result.runtime.containmentRequired,
      },
      "runtime.update: containment changed",
    );
  }
  return {
    runtime: runtimeRefOf(result.runtime),
    containmentRequired: result.runtime.containmentRequired,
  };
};
