// repository-heads-anywhere.ts: every binding head one repository has, in
// every workspace, on the shared Postgres plane and on each dedicated one.
//
// Many workspaces may link one repository, and one of them may also steer by
// it (ADR-293). Two readers need every head the repository has before any
// one workspace is in scope:
//
//   - The code repository check asks each workspace that links a repository
//     to check its pull requests (code-repo-check/request.ts).
//   - `create_github_token` refuses a token for a repository any workspace
//     steers by, because every token the shared GitHub App mints carries the
//     merge ruleset's bypass (ADR-228, tacho.github_token.issue.ts).
//
// The shared read goes through `withSystemDb`. An organization on a dedicated
// Postgres plane keeps its heads on that plane (ADR-042), out of the shared
// read, so each of its workspaces is read again in its own tenant scope.
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";

/** The hosts a binding head can name (`repository_binding_heads_provider_check`). */
export type HeadProvider = "github" | "gitlab";

/** One workspace that holds a head. */
export interface HeadScope {
  orgId: string;
  workspaceId: string;
}

/** One binding head for a repository. */
export interface HeadRow {
  orgId: string;
  workspaceId: string;
  role: string;
}

/** Where the readers find binding heads. Tests pass fakes. */
export interface RepositoryHeadReads {
  /** Every head for the repository on the shared Postgres plane. */
  sharedHeads(provider: HeadProvider, repositoryId: string): Promise<HeadRow[]>;
  /** Every workspace of an organization on a dedicated Postgres plane (ADR-042). */
  dedicatedScopes(): Promise<HeadScope[]>;
  /** The heads one dedicated-plane workspace holds for the repository. */
  headsOnPlane(
    scope: HeadScope,
    provider: HeadProvider,
    repositoryId: string,
  ): Promise<HeadRow[]>;
}

const headColumns = {
  orgId: schema.repositoryBindingHeads.orgId,
  workspaceId: schema.repositoryBindingHeads.workspaceId,
  role: schema.repositoryBindingHeads.role,
};

function sharedHeads(provider: HeadProvider, repositoryId: string): Promise<HeadRow[]> {
  // tenancy: a cross-tenant read before any tenant is known. Each caller
  // verified its request first (a signed webhook delivery, or an enrolled
  // host's key), and this reads only the org id, workspace id, and role of
  // the heads filtered by the host's immutable repository id.
  return withSystemDb((tx) =>
    tx
      .select(headColumns)
      .from(schema.repositoryBindingHeads)
      .where(
        and(
          eq(schema.repositoryBindingHeads.provider, provider),
          eq(schema.repositoryBindingHeads.providerRepositoryId, repositoryId),
        ),
      ),
  );
}

function dedicatedScopes(): Promise<HeadScope[]> {
  // tenancy: a cross-tenant read: a reader has to learn which organizations
  // live on a dedicated plane before it can scope anything. It reads only
  // org_id and workspace_id from the control plane, filtered to live
  // dedicated Postgres planes, and reads no tenant row. Each head is then
  // read in its own scope.
  return withSystemDb((tx) =>
    tx
      .select({ orgId: schema.workspaces.orgId, workspaceId: schema.workspaces.id })
      .from(schema.workspaces)
      .innerJoin(schema.dataPlanes, eq(schema.dataPlanes.orgId, schema.workspaces.orgId))
      .where(
        and(
          eq(schema.dataPlanes.kind, "postgres"),
          eq(schema.dataPlanes.mode, "dedicated"),
          isNull(schema.dataPlanes.deletedAt),
        ),
      ),
  );
}

function headsOnPlane(
  scope: HeadScope,
  provider: HeadProvider,
  repositoryId: string,
): Promise<HeadRow[]> {
  return runInTenantScope(scope, () =>
    withTenantDb((tx) =>
      tx
        .select(headColumns)
        .from(schema.repositoryBindingHeads)
        .where(
          and(
            eq(schema.repositoryBindingHeads.orgId, scope.orgId),
            eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
            eq(schema.repositoryBindingHeads.provider, provider),
            eq(schema.repositoryBindingHeads.providerRepositoryId, repositoryId),
          ),
        ),
    ),
  );
}

/** The binding heads in Postgres: the shared plane, then each dedicated one. */
export const postgresRepositoryHeads: RepositoryHeadReads = {
  sharedHeads,
  dedicatedScopes,
  headsOnPlane,
};

/** Every head the repository has, in every workspace on every plane. */
export async function headsAnywhere(
  provider: HeadProvider,
  repositoryId: string,
  deps: RepositoryHeadReads = postgresRepositoryHeads,
): Promise<HeadRow[]> {
  const rows = [...(await deps.sharedHeads(provider, repositoryId))];
  const read = new Set(rows.map((row) => row.workspaceId));
  for (const scope of await deps.dedicatedScopes()) {
    if (read.has(scope.workspaceId)) continue;
    rows.push(...(await deps.headsOnPlane(scope, provider, repositoryId)));
  }
  return rows;
}

/** True when any workspace, on any plane, holds the repository as its steering repository. */
export async function steeringAnywhere(
  provider: HeadProvider,
  repositoryId: string,
  deps: RepositoryHeadReads = postgresRepositoryHeads,
): Promise<boolean> {
  const rows = await headsAnywhere(provider, repositoryId, deps);
  return rows.some((row) => schema.isSteeringHeadRole(row.role));
}
