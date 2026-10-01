// legacy-source.ts: the code repository that still steers a workspace made
// before steering repos existed (#4875).
//
// The migration 20260927185600 turned each workspace's old main repository
// into its steering head. Such a head is bound through the code repository's
// own connection, not through `github_steering` or `gitlab_steering`, and its
// `.oxagen/` tree still holds the workspace's steering. Two readers need to
// tell it apart:
//
//   get_steering_repo   names it as `legacySource`, so the Repositories page
//                       offers to move steering instead of a retry that
//                       cannot bind a second steering repo
//   provisioning        stops before it creates a repository the bind step
//                       would then refuse (`steering_import_required`)
//
// import_workspace_steering demotes the head to linked before it provisions,
// so its own provisioning run finds no legacy source.
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import {
  GITHUB_STEERING_PROVIDER,
  GITLAB_STEERING_PROVIDER,
} from "../lib/steering-app";

/** The code repository that steers a workspace through its `.oxagen/` tree. */
export interface LegacySteeringSource {
  /** `github` or `gitlab`, as the head records it. */
  provider: string;
  /** `owner/name`. */
  full_name: string;
}

/**
 * The workspace's steering head when a code repository holds it, or null when
 * the workspace has no steering head or its head is a steering repo. It reads
 * inside the tenant scope the caller holds: the kernel's for the read
 * handler, and one the provision job enters for the workspace.
 */
export async function readLegacySteeringSource(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<LegacySteeringSource | null> {
  // tenancy: filtered by orgId and workspaceId, inside the caller's tenant
  // scope for the same workspace.
  const [head] = await withTenantDb((tx) =>
    tx
      .select({
        provider: schema.repositoryBindingHeads.provider,
        fullName: schema.repositoryBindings.providerFullName,
        connectorId: schema.sourceConnections.connectorId,
      })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .leftJoin(
        schema.sourceConnections,
        eq(
          schema.sourceConnections.id,
          schema.repositoryBindingHeads.connectionId,
        ),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          inArray(
            schema.repositoryBindingHeads.role,
            schema.STEERING_HEAD_ROLES,
          ),
        ),
      )
      .limit(1),
);
  if (head === undefined) return null;
  if (
    head.connectorId === GITHUB_STEERING_PROVIDER ||
    head.connectorId === GITLAB_STEERING_PROVIDER
  )
    return null;
  return { provider: head.provider, full_name: head.fullName };
}
