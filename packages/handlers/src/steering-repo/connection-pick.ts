// connection-pick.ts: store the connection a person picked for a workspace
// whose steering repo setup stopped with `choose_connection` (#4875).
//
// import_workspace_steering takes the pick, because a workspace still steered
// by a code repository gets its steering repo from the import's own
// provisioning run, not from a retry. The pick must be one of the choices the
// setup recorded, so a caller cannot point the organization at a host its
// tokens do not reach.
import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { and, eq } from "drizzle-orm";
import {
  pickSteeringConnection,
  readSteeringRepoState,
  resetSteeringConnection,
  saveSteeringRepoState,
  storeChosenSteeringConnection,
  type SteeringConnectionPick,
} from "../steering_repo.provision";

/**
 * Clear the organization's stored connection before an import provisions, so
 * its run lists the candidates again (#4899). Refused once Oxagen has created
 * a steering repo in the stored one.
 */
export async function resetOrganizationConnection(orgId: string): Promise<void> {
  await resetSteeringConnection(orgId);
}

/** Store `pick` as the organization's steering connection, or refuse it. */
export async function applyWorkspaceConnectionPick(
  scope: { orgId: string; workspaceId: string },
  pick: SteeringConnectionPick,
): Promise<void> {
  // tenancy: filtered by workspaceId and orgId together, inside the kernel's
  // tenant scope for the same workspace.
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, scope.workspaceId),
          eq(schema.workspaces.orgId, scope.orgId),
        ),
      )
      .limit(1),
  );
  const state = row === undefined ? null : readSteeringRepoState(row.settings);
  const chosen = pickSteeringConnection(state, pick);
  if (state === null || chosen === null)
    throw new HandlerError({
      code: "conflict",
      reason: "unknown_connection",
      message: `import_workspace_steering: ${pick.provider} ${pick.id} is not one of the connections this workspace's setup found. Read get_steering_repo for its connectionChoices.`,
    });
  await storeChosenSteeringConnection(scope.orgId, chosen);
  await saveSteeringRepoState(
    { kind: "workspace", ...scope },
    { ...state, connection_choices: [], updated_at: new Date().toISOString() },
  );
}
