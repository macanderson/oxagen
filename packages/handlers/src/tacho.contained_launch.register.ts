import { and, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  ambientPlaneKey,
  CONTAINED_LAUNCH_COLUMN,
  hasColumnFresh,
  schema,
  withTenantDb,
} from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { tachoContainedLaunchRegister } from "@oxagen/oxagen/contracts/tacho.contained_launch.register";
import { tachoDenied } from "./lib/tacho-host";

const CAPABILITY = "register_contained_launch";
const gatewayScope = z.object({
  purpose: z.literal("tacho_gateway_v1"),
  host_enrollment_id: z.string(),
});

export const tachoContainedLaunchRegisterHandler: CapabilityHandler<
  typeof tachoContainedLaunchRegister
> = async (input, ctx) => {
  if (!ctx.orgId || !ctx.workspaceId || !ctx.apiKeyId) {
    throw tachoDenied(CAPABILITY, "An enrolled gateway credential is required");
  }
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
  return withTenantDb(async (tx) => {
    const key = await tx.query.apiKeys.findFirst({
      where: and(
        eq(schema.apiKeys.id, ctx.apiKeyId!),
        eq(schema.apiKeys.orgId, ctx.orgId!),
        eq(schema.apiKeys.workspaceId, ctx.workspaceId!),
        isNull(schema.apiKeys.deletedAt),
        or(
          isNull(schema.apiKeys.expiresAt),
          gt(schema.apiKeys.expiresAt, new Date()),
        ),
      ),
      columns: { id: true, scope: true },
    });
    const scope = gatewayScope.safeParse(key?.scope);
    if (
      !key ||
      !scope.success ||
      scope.data.host_enrollment_id !== input.host_enrollment_id
    ) {
      throw tachoDenied(
        CAPABILITY,
        "The gateway credential does not name this host",
      );
    }
    const host = await tx.query.tachoHosts.findFirst({
      where: and(
        eq(schema.tachoHosts.publicId, scope.data.host_enrollment_id),
        eq(schema.tachoHosts.orgId, ctx.orgId!),
        eq(schema.tachoHosts.workspaceId, ctx.workspaceId!),
      ),
      columns: { id: true, status: true, expiresAt: true },
    });
    if (
      !host ||
      host.status !== "active" ||
      host.expiresAt.getTime() <= Date.now()
    ) {
      throw tachoDenied(CAPABILITY, "The host enrollment is not active");
    }
    if (
      !(await hasColumnFresh(
        tx,
        CONTAINED_LAUNCH_COLUMN,
        await ambientPlaneKey(),
      ))
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "containment_not_ready",
        message: "Containment registration requires the database migration",
      });
    }
    await tx
      .insert(schema.tachoContainedLaunches)
      .values({
        orgId: ctx.orgId!,
        workspaceId: ctx.workspaceId!,
        hostId: host.id,
        sessionUuid: input.session_uuid,
        genesisHash: input.genesis_hash,
        measurement: input.measurement,
      })
      .onConflictDoNothing({
        target: [
          schema.tachoContainedLaunches.hostId,
          schema.tachoContainedLaunches.sessionUuid,
        ],
      });
    const recorded = await tx.query.tachoContainedLaunches.findFirst({
      where: and(
        eq(schema.tachoContainedLaunches.hostId, host.id),
        eq(schema.tachoContainedLaunches.sessionUuid, input.session_uuid),
      ),
      columns: { genesisHash: true, measurement: true },
    });
    // Retries are idempotent, but a new container or genesis cannot reuse a receipt.
    if (
      !recorded ||
      recorded.genesisHash !== input.genesis_hash ||
      Object.entries(input.measurement).some(
        ([key, value]) => recorded.measurement[key] !== value,
      )
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "contained_launch_mismatch",
        message:
          "This session already has a different containment registration",
      });
    }
    return { registered: true as const };
  });
};
