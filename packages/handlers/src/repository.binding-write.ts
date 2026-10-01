// repository.binding-write.ts: the one writer of a NEW binding head, shared
// by the steering provisioner (the steering head, steering_repo.provision.ts)
// and the steering sync (a linked head, once a steering PR that lists the
// repository merges; see repository.link.write.ts). It also holds what every
// writer of a workspace's heads shares: the workspace lock, the reading of a
// head write the store refused, the check that the global claim is knowable,
// and the GitHub repository reader.
//
// `bind_main_repository` was the last writer that repaired or re-approved an
// EXISTING head in place. #4616 removed it (ADR-212), so a head is now only
// ever added here, and `set_production_branch` moves an existing one.
//
// A binding is immutable and versioned (`ingestion.repository_bindings`), and
// `repository_bindings_repository_version_uq` is on (connection, repository,
// version). A repository this connection bound before — linked, unlinked, and
// now linked again — therefore already HAS a version 1, and writing another
// would violate that index. So the latest version for the pair is read first:
// reused when nothing it records has moved, superseded by version + 1 when
// something has, and only when there is none is a version 1 written.
import { HandlerError } from "@oxagen/oxagen";
import { schema, type Tx, withSystemDb } from "@oxagen/database";
import { createGitHubClient, getInstallationToken } from "@oxagen/github";
import type { GitHubRepoInfo } from "@oxagen/github";
import { assertDataPlaneUsable, resolveDataPlane } from "@oxagen/tenancy";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { GITHUB_PROVIDER } from "./repository.github-connection";

/**
 * The transaction-scoped advisory lock every writer of a workspace's binding
 * heads takes, so each reads the heads the previous one committed. The
 * writers are `link_repository`, the steering sync, `unlink_repository`,
 * `set_production_branch`, and the steering provisioner's bind step. The key
 * keeps the spelling of `bind_main_repository`, its first writer (removed in
 * #4616), so a deploy that mixes old and new processes still serialises on
 * one lock.
 */
export function workspaceRepositoriesLock(workspaceId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bind_main_repository:${workspaceId}`}::text, 0))`;
}

/**
 * A head's role (`repository_binding_heads_role_check`). `steering` is the
 * workspace's steering record source, of which it has one; `linked` is a code
 * repository, of which it may have many. 20260927185600 moved every former
 * `main` head to `steering` (ADR-212).
 */
export type RepositoryHeadRole = "linked" | "steering";

/** The hosts a binding can name (`repository_bindings_provider_check`). */
export type RepositoryProvider = "github" | "gitlab";

/**
 * The repository facts a binding records, whichever host reported them. A
 * GitHub `GitHubRepoInfo` satisfies it; on GitLab `owner` is the full
 * namespace path and `id` the numeric project id.
 */
export interface BindableRepository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

/**
 * What a 23505 from the heads table means, by constraint name. The partial
 * unique index refuses a second steering head for one repository; the trigger
 * `repository_binding_heads_exclusive_main`
 * (20260918200000_repository_binding_heads_exclusive_across_roles.sql) raises
 * the same code under three names, one of them the index's own, so a writer
 * maps the racing case and the ordinary case to one sentence.
 */
const HEAD_CONFLICT_BY_CONSTRAINT: Readonly<
  Record<string, RepositoryHeadConflict>
> = {
  // The repository is another workspace's steering repository. Raised by the
  // index and by the trigger for a steering head written where one exists
  // elsewhere.
  repository_binding_heads_main_repository_uq: "main_elsewhere",
  // A linked head written where a steering head exists elsewhere: the same
  // fact, seen from the other side.
  repository_binding_heads_linked_is_main_elsewhere: "main_elsewhere",
  // A steering head written where a linked head exists elsewhere.
  repository_binding_heads_main_is_linked_elsewhere: "linked_elsewhere",
};

/**
 * Which cross-workspace rule a head write broke: the repository steers another
 * workspace, or another workspace links it and it was being claimed as a
 * steering repository. The names keep the store's `main` spelling.
 */
export type RepositoryHeadConflict = "main_elsewhere" | "linked_elsewhere";

/**
 * The cross-workspace rule a failed head write broke, or null when the error
 * is something else.
 *
 * Matched on the constraint NAME rather than on 23505 alone: this insert can
 * also violate `repository_binding_heads_repository_uq`, which means something
 * else entirely, and reporting that as "claimed by another workspace" would
 * send the operator to look for a workspace that does not exist. Postgres
 * carries the name on the error; the driver nests it under `cause`.
 */
export function repositoryHeadConflict(
  err: unknown,
): RepositoryHeadConflict | null {
  for (let e: unknown = err, hops = 0; e != null && hops < 5; hops++) {
    const row = e as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (row.code === "23505" && typeof row.constraint_name === "string") {
      return HEAD_CONFLICT_BY_CONSTRAINT[row.constraint_name] ?? null;
    }
    e = row.cause;
  }
  return null;
}

/**
 * Refuse unless the global steering-repository claim is actually knowable.
 *
 * `repository_binding_heads_main_repository_uq` is global only within ONE
 * Postgres. ADR-042 lets an organisation carry a dedicated plane, and
 * ingestion is tenant data such a plane holds, so the guard has two blind
 * spots and BOTH of them admit exactly the second claim it exists to refuse:
 *
 *   1. THIS organisation is dedicated. Its heads live on its own plane, where
 *      neither the shared index nor the shared read can see them, and the
 *      claim it writes is invisible to every other tenant.
 *   2. ANY OTHER organisation is dedicated. Then a steering head may already
 *      exist on that plane for this repository, and a shared-plane read
 *      returns nothing while the claim is real.
 *
 * Both are refused rather than guessed, the way `billing.evidence_retention`
 * refuses the same ADR-042 gap. The real repair is a plane-aware global claim
 * check, which is a change to the store seam. No organisation is dedicated
 * today (ADR-042 §1: absence of a row means shared, and the dedicated mode
 * has no customer), so nothing in service reaches either refusal.
 *
 * `org.data_planes` is itself always on the shared plane (a plane binding
 * cannot be stored on the plane it describes), so one `withSystemDb` read
 * answers (2) for every tenant at once.
 */
export async function assertGlobalClaimIsKnowable(
  orgId: string,
): Promise<void> {
  const plane = await resolveDataPlane(orgId, "postgres");
  // Throws DataPlaneUnavailableError for any binding that is not active.
  assertDataPlaneUsable(plane);
  if (plane.mode !== "shared") throw planeUnsupported();

  // tenancy: global read of org.data_planes, a shared-plane system table, with
  // no org_id filter by design. It reads one row id to learn whether any
  // dedicated plane exists, and nothing outside this function sees the id.
  const dedicatedElsewhere = await withSystemDb((tx) =>
    tx
      .select({ id: schema.dataPlanes.id })
      .from(schema.dataPlanes)
      .where(
        and(
          eq(schema.dataPlanes.kind, "postgres"),
          eq(schema.dataPlanes.mode, "dedicated"),
          isNull(schema.dataPlanes.deletedAt),
        ),
      )
      .limit(1),
  );
  if (dedicatedElsewhere.length > 0) {
    logger.warn(
      { orgId },
      "repository head claim refused: a dedicated Postgres plane exists, so the global steering-repository claim cannot be checked",
    );
    throw planeUnsupported();
  }
}

/**
 * Re-ask which plane the organisation is on, uncached, from inside the
 * transaction that writes a head (#3340 finding 1).
 *
 * `assertGlobalClaimIsKnowable` asks before the transaction opens. When the
 * organisation's Postgres plane moves between that answer and the write,
 * `withTenantDb` writes the head on the new dedicated plane, where neither the
 * shared trigger nor a cross-tenant read can see it, and another workspace
 * can later claim the same repository. Asking again inside the transaction
 * narrows that window to the transaction itself.
 *
 * `loadDataPlaneBinding`, not `resolveDataPlane`: the resolver caches per
 * process, and `set_data_plane` invalidates only the process it ran in, so a
 * cached re-ask would hand back the same stale `shared` answer the pre-check
 * had and check nothing.
 */
export async function assertPlaneStillShared(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<void> {
  // Loaded on first use, as `get_data_plane` loads it, so the many importers
  // of this module do not load the plane resolver until a head is written.
  const { loadDataPlaneBinding } = await import("@oxagen/database/data-plane");
  const planeNow = await loadDataPlaneBinding(scope.orgId, "postgres");
  assertDataPlaneUsable(planeNow);
  if (planeNow.mode !== "shared") {
    logger.warn(
      { orgId: scope.orgId, workspaceId: scope.workspaceId },
      "repository head write refused mid-transaction: the organization's Postgres plane moved after the pre-check",
    );
    throw planeUnsupported();
  }
}

function planeUnsupported(): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "main_repo_plane_unsupported",
    message:
      "Oxagen cannot yet prove this repository is not another workspace's steering repository. A dedicated data plane is in use, and the uniqueness guard holds only within one database, so Oxagen refuses the write rather than admit a claim it cannot check.",
  });
}

/** Reads a repository through a GitHub App installation. Tests pass a fake. */
export interface MainRepositoryDeps {
  /** The repository as the installation sees it, or null when it cannot. */
  repository(
    installationId: string,
    owner: string,
    name: string,
  ): Promise<GitHubRepoInfo | null>;
}

export const githubMainRepositoryDeps: MainRepositoryDeps = {
  async repository(installationId, owner, name) {
    const appId = process.env["GITHUB_APP_ID"];
    const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
    if (!appId || !privateKey) {
      throw new Error(
        "GitHub App is not configured: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY unset",
      );
    }
    const { token } = await getInstallationToken({
      appId,
      privateKey,
      installationId,
    });
    try {
      return await createGitHubClient({ token }).getRepoInfo({
        owner,
        repo: name,
      });
    } catch (err) {
      // The client throws on every non-2xx; an installation that cannot see
      // the repository answers 404, which is the refusal a writer names.
      if (
        err instanceof Error &&
        err.message.startsWith("GitHub API error 404")
      )
        return null;
      throw err;
    }
  },
};

export interface NewRepositoryHead {
  scope: { orgId: string; workspaceId: string };
  /** The `source_connections` row the head and binding hang off. */
  connectionId: string;
  repo: BindableRepository;
  role: RepositoryHeadRole;
  /**
   * The host. Defaults to GitHub, the only host `link_repository` binds
   * today; the steering provisioner passes GitLab for a GitLab group. `provider_repository_id` is unique only
   * within one host, so the retained-version lookup filters on it too.
   */
  provider?: RepositoryProvider;
  /**
   * The person who asked for the head, or null when the steering sync writes
   * it after a steering PR merged (ADR-212). The merge is the host's fact,
   * and the merging account need not be an Oxagen user.
   */
  userId: string | null;
  now: Date;
}

export interface WrittenRepositoryHead {
  /** `rpb_…` of the binding version the new head points at. */
  bindingPublicId: string;
}

/**
 * Write a binding head for `repo` on `tx`, reusing the latest binding version
 * when nothing it records has moved, and superseding it otherwise. The caller
 * has already decided the head may exist (role, duplicates, claims) and holds
 * the workspace lock.
 *
 * The latest version is the workspace's for this repository through ANY
 * connection (#3340 finding 7). A binding version is the evidence an admitted
 * run cites, and the versions of one repository in one workspace form one
 * lineage. Looked up on the connection alone, a relink through the
 * connection that replaced a retired one found nothing and wrote a second
 * version 1 with no predecessor, splitting the chain. A version another
 * connection holds is superseded, never reused, so the head and its binding
 * name the same connection.
 */
export async function writeRepositoryHead(
  tx: Tx,
  args: NewRepositoryHead,
): Promise<WrittenRepositoryHead> {
  const { scope, connectionId, repo, role, userId, now } = args;
  const provider = args.provider ?? GITHUB_PROVIDER;

  const [latest] = await tx
    .select({
      id: schema.repositoryBindings.id,
      publicId: schema.repositoryBindings.publicId,
      connectionId: schema.repositoryBindings.connectionId,
      version: schema.repositoryBindings.version,
      providerOwner: schema.repositoryBindings.providerOwner,
      providerName: schema.repositoryBindings.providerName,
      providerFullName: schema.repositoryBindings.providerFullName,
      configuredDefaultRef: schema.repositoryBindings.configuredDefaultRef,
    })
    .from(schema.repositoryBindings)
    .where(
      and(
        eq(schema.repositoryBindings.orgId, scope.orgId),
        eq(schema.repositoryBindings.workspaceId, scope.workspaceId),
        eq(schema.repositoryBindings.provider, provider),
        eq(schema.repositoryBindings.providerRepositoryId, repo.id),
      ),
    )
    .orderBy(
      desc(schema.repositoryBindings.version),
      desc(schema.repositoryBindings.createdAt),
    )
    .limit(1);

  let binding: { id: string; publicId: string };
  const unchanged =
    latest !== undefined &&
    latest.connectionId === connectionId &&
    latest.providerOwner === repo.owner &&
    latest.providerName === repo.name &&
    latest.providerFullName === repo.fullName &&
    latest.configuredDefaultRef === repo.defaultBranch;
  if (latest !== undefined && unchanged) {
    binding = { id: latest.id, publicId: latest.publicId };
  } else {
    const [inserted] = await tx
      .insert(schema.repositoryBindings)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        connectionId,
        provider,
        providerRepositoryId: repo.id,
        providerOwner: repo.owner,
        providerName: repo.name,
        providerFullName: repo.fullName,
        configuredDefaultRef: repo.defaultBranch,
        observedAt: now,
        version: latest === undefined ? 1 : latest.version + 1,
        supersedesBindingId: latest === undefined ? null : latest.id,
        createdAt: now,
        createdById: userId,
      })
      .returning({
        id: schema.repositoryBindings.id,
        publicId: schema.repositoryBindings.publicId,
      });
    if (!inserted)
      throw new Error("repository_bindings insert returned no row");
    binding = inserted;
  }

  await tx.insert(schema.repositoryBindingHeads).values({
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    connectionId,
    provider,
    providerRepositoryId: repo.id,
    currentBindingId: binding.id,
    // Written out rather than left to the column default: which role a head
    // carries is the whole question `repository_binding_heads_main_repository_uq`
    // answers.
    role,
    createdAt: now,
    updatedAt: now,
  });

  return { bindingPublicId: binding.publicId };
}
