// context.steering.index.get.ts: `get_steering_index`, the read behind
// `oxagen check` (#4555).
//
// Flow:
//   1. The workspace's published version as it stands now, read through the
//      same port the Tacho host routes use. `index` is null until the
//      workspace publishes its first version.
//   2. The check context: the five lists of names the references check
//      resolves a steering PR against, read in one tenant transaction.
//
// No store is written.
import type { CapabilityHandler } from "@oxagen/oxagen";
import type {
  SteeringCheckContext,
  SteeringIndexRecord,
  steeringIndexGet,
} from "@oxagen/oxagen/contracts/context.steering.index.get";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { TachoPublished } from "./tacho.published";

type Scope = { orgId: string; workspaceId: string };

export interface SteeringIndexGetDeps {
  /**
   * The workspace's and the organization's versions published now. The port
   * takes a scope with a null run id, because a check reads for a repo, not
   * for a run.
   */
  published: TachoPublished["published"];
  /** The names the references check resolves against. */
  readContext: (scope: Scope) => Promise<SteeringCheckContext>;
}

/**
 * The published records as the checks read them. A record carries no
 * statement: `bundle/v1` keeps a record's body in the repository and holds
 * only its blob, so the conflicts check has no text to compare here.
 */
export function indexRecords(bundle: Bundle): SteeringIndexRecord[] {
  return bundle.records.map((record) => ({
    lineage: record.lineage,
    path: record.path,
    id: record.id,
    hash: record.hash,
    kind: record.kind,
    effect: record.effect ?? null,
  }));
}

/** Sorted, with each name once. */
function names(rows: readonly { name: string }[]): string[] {
  return [...new Set(rows.map((row) => row.name))].sort();
}

/**
 * The five lists for one workspace, read under tenant scope.
 *
 * - runtimes: each live runtime's slug in the workspace.
 * - credentials: each credential's name in the workspace, the `<name>` of
 *   `oxagen:credential/<name>`. A revoked credential is left out. One that
 *   needs reauthorizing stays, because the name still resolves. An
 *   organization-shared credential sits under a sentinel workspace id that
 *   workspace scope cannot see. No path writes one today.
 * - members: each organization member's public user id, which an agent
 *   file Oxagen writes names as its operator (ADR-266).
 * - teams, groups: empty. See each line below.
 */
export async function readCheckContext(
  scope: Scope,
): Promise<SteeringCheckContext> {
  return withTenantDb(async (tx) => {
    const runtimes = await tx
      .select({ name: schema.runtimes.slug })
      .from(schema.runtimes)
      .where(
        and(
          eq(schema.runtimes.orgId, scope.orgId),
          eq(schema.runtimes.workspaceId, scope.workspaceId),
          isNull(schema.runtimes.deletedAt),
        ),
      );
    const credentials = await tx
      .select({ name: schema.mcpCredentials.name })
      .from(schema.mcpCredentials)
      .where(
        and(
          eq(schema.mcpCredentials.orgId, scope.orgId),
          eq(schema.mcpCredentials.workspaceId, scope.workspaceId),
          ne(schema.mcpCredentials.status, "revoked"),
        ),
      );
    // Each member of the organization by public user id (`usr_…`). Oxagen
    // has no member handles, so the agent file it writes for an enrolled
    // host names its operator this way (ADR-266).
    const members = await tx
      .select({ name: schema.users.publicId })
      .from(schema.users)
      .innerJoin(
        schema.orgUsers,
        and(
          eq(schema.orgUsers.userId, schema.users.id),
          eq(schema.orgUsers.orgId, scope.orgId),
        ),
      )
      .where(isNull(schema.users.deletedAt));
    return {
      runtimes: names(runtimes),
      members: names(members),
      // Empty: Oxagen has no teams table.
      teams: [],
      // Empty: no table holds a reviewer group slug. SCIM groups carry a
      // display name and an external id, not a slug.
      groups: [],
      credentials: names(credentials),
    };
  });
}

export function createSteeringIndexGetHandler(
  deps: SteeringIndexGetDeps,
): CapabilityHandler<typeof steeringIndexGet> {
  return async (_input, ctx) => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const delivery = await deps.published({ ...scope, runId: null });
    const context = await deps.readContext(scope);
    return {
      index:
        delivery.workspace === null
          ? null
          : { records: indexRecords(delivery.workspace) },
      context,
    };
  };
}

export const steeringIndexGetHandler = createSteeringIndexGetHandler({
  // Imported on first call, so a test of this file does not load the store.
  published: async (scope) =>
    (await import("./tacho.published.postgres")).postgresTachoPublished.published(
      scope,
    ),
  readContext: readCheckContext,
});
