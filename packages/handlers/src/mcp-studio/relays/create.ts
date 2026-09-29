// create.ts: `create_relay` (M12, #4685).
//
// Flow:
//   1. Role gate: the contract's roles, org Owner or Admin (INV-29). The gate
//      also refuses a context with no acting user, and the row records who
//      created it.
//   2. The token: generateRelayToken() mints oxr_ and 32 random bytes. The
//      row stores hashRelayToken(token), the SHA-256, and never the token.
//   3. The row: one live relay per name in a workspace. A second create of a
//      live name is `conflict`, reason `relay_name_taken`, whether the
//      pre-check finds it or the partial unique index refuses the insert.
//
// The kernel's capability.invoke_* event audits the call, and the contract's
// `audit` field names the relay. The token is never logged.
import { isUniqueViolation, withSystemDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { toolRelayCreate } from "@oxagen/oxagen/contracts/tool.relay.create";
import {
  generateRelayToken,
  hashRelayToken,
} from "@oxagen/relay-broker/tokens";
import { contractRoleRequirement } from "../../lib/capability-role-guard";
import { logger } from "../../logger";
import {
  findLiveRelay,
  insertRelay,
  readWorkspacePublicId,
  type RelayScope,
} from "./store";

/** The partial unique index on (org_id, workspace_id, name) WHERE revoked_at IS NULL. */
const LIVE_NAME_INDEX = "relays_workspace_name_live_uq";

function nameTaken(name: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "relay_name_taken",
    message: `This workspace already has a live relay named "${name}". Revoke it first, or choose another name.`,
  });
}

export const toolRelayCreateHandler: CapabilityHandler<
  typeof toolRelayCreate
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    contractRoleRequirement(toolRelayCreate),
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const scope: RelayScope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const token = generateRelayToken();
  const tokenHash = hashRelayToken(token);
  const now = new Date();

  // tenancy: every read and write here is filtered by the caller's orgId and workspaceId, after the role gate verified the acting user's org role.
  const row = await withSystemDb(async (tx) => {
    const workspacePublicId = await readWorkspacePublicId(tx, scope);
    if (!workspacePublicId) {
      throw new HandlerError({
        code: "not_found",
        reason: "workspace_not_found",
        message:
          "This workspace is not in your organization. Check the workspace and try again.",
      });
    }
    if (await findLiveRelay(tx, scope, input.name)) throw nameTaken(input.name);
    return insertRelay(tx, {
      scope,
      workspacePublicId,
      name: input.name,
      tokenHash,
      createdById: userId,
      createdAt: now,
    });
  }).catch((err: unknown) => {
    // Two creates of one name can both find no live row and both insert. The
    // partial unique index turns the second insert into a 23505, which aborts
    // its transaction, so the conflict is answered here, outside it.
    if (isUniqueViolation(err, LIVE_NAME_INDEX)) throw nameTaken(input.name);
    throw err;
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      relayId: row.publicId,
      relay: row.name,
    },
    "create_relay: relay registered",
  );

  return {
    publicId: row.publicId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    token,
  };
};
