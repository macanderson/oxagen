// revoke.ts: `revoke_relay` (M12, #4685).
//
// Flow:
//   1. Role gate: the contract's roles, org Owner or Admin (INV-29).
//   2. The row: set revoked_at and revoked_by_id on the live relay with this
//      name in the caller's workspace. A name with no live relay there, a
//      relay already revoked, or one in another workspace is `not_found`,
//      reason `relay_not_found`.
//
// The broker checks each connected relay's token again every 30 seconds, so a
// connected relay is closed within 30 seconds, and its next connect is
// refused. The kernel's capability.invoke_* event audits the call, and the
// contract's `audit` field names the relay.
import { withSystemDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { toolRelayRevoke } from "@oxagen/oxagen/contracts/tool.relay.revoke";
import { contractRoleRequirement } from "../../lib/capability-role-guard";
import { logger } from "../../logger";
import { revokeLiveRelay, type RelayScope } from "./store";

export const toolRelayRevokeHandler: CapabilityHandler<
  typeof toolRelayRevoke
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    contractRoleRequirement(toolRelayRevoke),
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const scope: RelayScope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const now = new Date();

  // tenancy: every read and write here is filtered by the caller's orgId and workspaceId, after the role gate verified the acting user's org role.
  const row = await withSystemDb((tx) =>
    revokeLiveRelay(tx, scope, input.name, userId, now),
  );
  if (!row?.revokedAt) {
    throw new HandlerError({
      code: "not_found",
      reason: "relay_not_found",
      message: `This workspace has no live relay named "${input.name}". Check the name. A relay that is already revoked cannot be revoked again.`,
    });
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      relayId: row.publicId,
      relay: row.name,
    },
    "revoke_relay: relay revoked",
  );

  return {
    publicId: row.publicId,
    name: row.name,
    revokedAt: row.revokedAt.toISOString(),
  };
};
