// audit-exempt: a webhook-driven trigger; it stamps when a sync was requested and sends the sync event. The sync's own publications go to the promotions ledger.
//
// context.steering.sync.request.ts: which workspaces a host delivery asks to
// sync (ADR-184), and the request itself.
//
// A delivery never says what changed in the registry. It says a branch moved
// or a pull request closed, and the sync reads the branch for itself. So this
// only has to find the workspaces whose main repository the delivery is about,
// and whose production branch it touched, and ask each for a sync.
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { eventClient } from "./event-client";
import { logger } from "./logger";
import { postgresSyncStore } from "./context.steering.sync.store";

export interface SyncScope {
  orgId: string;
  workspaceId: string;
}

/** The pull request actions that can change what the sync decides. */
const PULL_REQUEST_ACTIONS = new Set([
  "closed",
  "synchronize",
  "reopened",
  "edited",
]);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/**
 * The branch a GitHub delivery moved or merged into, or null when the
 * delivery cannot change a workspace's steering.
 */
export function githubDeliveryBranch(
  eventName: string,
  body: Record<string, unknown>,
): string | null {
  if (eventName === "push") {
    const ref = str(body.ref);
    return ref?.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : null;
  }
  if (eventName === "pull_request") {
    if (!PULL_REQUEST_ACTIONS.has(str(body.action) ?? "")) return null;
    const pr = body.pull_request as
      | { base?: { ref?: unknown }; head?: { ref?: unknown } }
      | undefined;
    // Only a Context PR has a proposal to settle. Any other PR that merges
    // into the production branch arrives as that branch's push, which is
    // what changes records; asking on every PR edit would put the page into
    // "pending" for nothing.
    if (!str(pr?.head?.ref)?.startsWith("context/")) return null;
    return str(pr?.base?.ref);
  }
  return null;
}

/** How the routing reaches organizations whose Postgres is a dedicated plane. */
export interface DedicatedPlaneDeps {
  /** Every workspace of an organization on a dedicated plane. */
  dedicatedScopes(): Promise<SyncScope[]>;
  /**
   * The approved production branch of the workspace's main head for this
   * GitHub repository id, read on the workspace's own plane, or null.
   */
  mainRefOnPlane(
    scope: SyncScope,
    repositoryId: string,
  ): Promise<string | null>;
}

// tenancy: webhook routing has to learn which organizations live on a
// dedicated plane before it can scope anything. It reads only org_id and
// workspace_id from the control plane, filtered to live dedicated Postgres
// planes, and reads no tenant row; each head is then read in its own scope.
const dedicatedPlaneDeps: DedicatedPlaneDeps = {
  dedicatedScopes: () =>
    withSystemDb((tx) =>
      tx
        .select({
          orgId: schema.workspaces.orgId,
          workspaceId: schema.workspaces.id,
        })
        .from(schema.workspaces)
        .innerJoin(
          schema.dataPlanes,
          eq(schema.dataPlanes.orgId, schema.workspaces.orgId),
        )
        .where(
          and(
            eq(schema.dataPlanes.kind, "postgres"),
            eq(schema.dataPlanes.mode, "dedicated"),
            isNull(schema.dataPlanes.deletedAt),
          ),
        ),
    ),
  mainRefOnPlane: (scope, repositoryId) =>
    runInTenantScope(scope, () =>
      withTenantDb(async (tx) => {
        const [row] = await tx
          .select({ ref: schema.repositoryBindings.configuredDefaultRef })
          .from(schema.repositoryBindingHeads)
          .innerJoin(
            schema.repositoryBindings,
            eq(
              schema.repositoryBindings.id,
              schema.repositoryBindingHeads.currentBindingId,
            ),
          )
          .where(
            and(
              eq(schema.repositoryBindingHeads.orgId, scope.orgId),
              eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
              eq(schema.repositoryBindingHeads.provider, "github"),
              eq(
                schema.repositoryBindingHeads.providerRepositoryId,
                repositoryId,
              ),
              eq(schema.repositoryBindingHeads.role, "main"),
            ),
          )
          .limit(1);
        return row?.ref ?? null;
      }),
    ),
};

/**
 * The workspaces a GitHub `push` or `pull_request` delivery asks to sync: every
 * workspace whose main repository is the delivery's repository, by GitHub's
 * immutable id, and whose approved production branch the delivery touched.
 *
 * A workspace connected through the legacy sources wizard has no binding. It
 * is found through its connection's `delivery_config`, as the ingestion
 * routing finds it, and its production branch is the repository's default.
 */
export async function githubSyncTargets(
  args: {
    eventName: string;
    body: Record<string, unknown>;
    installationId: string | null;
  },
  deps: DedicatedPlaneDeps = dedicatedPlaneDeps,
): Promise<SyncScope[]> {
  const branch = githubDeliveryBranch(args.eventName, args.body);
  if (!branch) return [];
  const repository = (args.body.repository ?? {}) as {
    id?: unknown;
    full_name?: unknown;
    default_branch?: unknown;
  };
  const repositoryId =
    typeof repository.id === "number" || typeof repository.id === "string"
      ? String(repository.id)
      : null;
  if (!repositoryId) return [];

  // tenancy: webhook routing before any tenant is known; the delivery's HMAC
  // was verified by the route, and this reads only org_id and workspace_id of
  // the main heads filtered by GitHub's repository id.
  const bound = await withSystemDb((tx) =>
    tx
      .select({
        orgId: schema.repositoryBindingHeads.orgId,
        workspaceId: schema.repositoryBindingHeads.workspaceId,
        ref: schema.repositoryBindings.configuredDefaultRef,
      })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.provider, "github"),
          eq(schema.repositoryBindingHeads.providerRepositoryId, repositoryId),
          eq(schema.repositoryBindingHeads.role, "main"),
        ),
      ),
  );
  const targets = new Map<string, SyncScope>();
  for (const row of bound)
    if (row.ref === branch)
      targets.set(row.workspaceId, {
        orgId: row.orgId,
        workspaceId: row.workspaceId,
      });

  // An organization on a dedicated Postgres plane (ADR-042) keeps its binding
  // heads on that plane, out of the shared read above. Each of its
  // workspaces is asked in its own scope.
  for (const scope of await deps.dedicatedScopes()) {
    if (targets.has(scope.workspaceId)) continue;
    const ref = await deps.mainRefOnPlane(scope, repositoryId);
    if (ref === branch) targets.set(scope.workspaceId, scope);
  }

  const fullName = str(repository.full_name);
  if (
    args.installationId &&
    fullName &&
    branch === str(repository.default_branch)
  ) {
    const [owner, name] = fullName.split("/");
    // tenancy: webhook routing before any tenant is known; filtered by the
    // verified delivery's installation id and repository, and by workspaces
    // that hold no main binding head of their own.
    const legacy = await withSystemDb((tx) =>
      tx
        .select({
          orgId: schema.sourceConnections.orgId,
          workspaceId: schema.sourceConnections.workspaceId,
        })
        .from(schema.sourceConnections)
        .where(
          and(
            eq(schema.sourceConnections.connectorId, "github"),
            isNull(schema.sourceConnections.deletedAt),
            notInArray(schema.sourceConnections.status, [
              "deleting",
              "deleted",
            ]),
            sql`${schema.sourceConnections.deliveryConfig} ->> 'installationId' = ${args.installationId}`,
            sql`lower(${schema.sourceConnections.deliveryConfig} ->> 'owner') = ${(owner ?? "").toLowerCase()}`,
            sql`lower(${schema.sourceConnections.deliveryConfig} ->> 'repo') = ${(name ?? "").toLowerCase()}`,
            sql`not exists (select 1 from ${schema.repositoryBindingHeads} h where h.workspace_id = ${schema.sourceConnections.workspaceId} and h.role = 'main')`,
          ),
        ),
    );
    for (const row of legacy)
      targets.set(row.workspaceId, {
        orgId: row.orgId,
        workspaceId: row.workspaceId,
      });
  }
  return [...targets.values()];
}

/**
 * Ask each workspace for a sync: stamp `requested_at`, so a page open on it
 * shows a sync on its way, then send the event. A stamp that fails does not
 * stop the event; the event is what does the work.
 */
export async function requestSteeringSync(
  targets: SyncScope[],
  reason: string,
  deps: {
    markRequested: (scope: SyncScope, at: Date) => Promise<void>;
    send: (events: SteeringSyncEvent[]) => Promise<unknown>;
    now: () => Date;
  } = {
    markRequested: (scope, at) =>
      runInTenantScope(scope, () => postgresSyncStore.markRequested(scope, at)),
    send: (events) => eventClient.send(events),
    now: () => new Date(),
  },
): Promise<number> {
  if (targets.length === 0) return 0;
  const at = deps.now();
  await Promise.all(
    targets.map((scope) =>
      deps
        .markRequested(scope, at)
        .catch((err: unknown) =>
          logger.warn(
            { err, workspaceId: scope.workspaceId },
            "context.sync: could not stamp the sync request",
          ),
        ),
    ),
  );
  await deps.send(
    targets.map((scope) => ({
      name: "steering/sync.requested" as const,
      data: { ...scope, reason },
    })),
  );
  return targets.length;
}

export interface SteeringSyncEvent {
  name: "steering/sync.requested";
  data: { orgId: string; workspaceId: string; reason: string } & Record<
    string,
    unknown
  >;
}
