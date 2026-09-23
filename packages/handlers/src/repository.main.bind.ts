// repository.main.bind.ts — `bind_main_repository` (#2967).
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29).
//   2. The installation: the workspace's GitHub connection carrying the
//      installation id the HMAC-verified callback attached
//      (apps/api/src/routes/v1/github-oauth.ts). The caller never names one.
//   3. The repository, read through the installation's token: the numeric id
//      a binding pins, the canonical owner/name, and the default branch. A
//      repository the installation cannot see is a not_found.
//   4. Exclusivity ACROSS workspaces: does any other workspace hold a head
//      for this repository, main or linked? The heads table is tenant-scoped,
//      so that read crosses the boundary through `withSystemDb` — the advisory
//      lock in step 5 never could, being keyed on this workspace alone. The
//      guarantee is the store's: `repository_binding_heads_main_repository_uq`
//      for main against main, and the trigger
//      `repository_binding_heads_exclusive_main` for the rest, which takes a
//      repository-keyed advisory lock so two writers for one repository
//      serialise across workspaces. This read exists so the ordinary case
//      refuses with a sentence (`main_repo_claimed` when the repository is
//      main elsewhere, `repository_linked_elsewhere` when it is linked
//      elsewhere), and the catch around step 5 so the racing case refuses
//      with the same one.
//   5. One transaction, holding a transaction-scoped advisory lock on the
//      workspace so two binds IN THIS WORKSPACE read the heads one after the
//      other: the workspace's heads, of EITHER role, decide idempotent /
//      promote (a head this workspace already holds as linked for this
//      repository becomes main in place) / repair (the same repository through
//      a replacement connection, which supersedes the binding onto it) /
//      conflict; else the binding and its `role = 'main'` head through
//      `writeRepositoryHead`, which reuses a version retained from an unlinked
//      head instead of colliding with it; then the connection marked
//      connected, and the gate's provisional window closed when this workspace
//      is the gate's. No table
//      constraint holds one head per WORKSPACE, so the lock is still what
//      keeps this workspace to a single main repository.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryMainBind,
  type RepositoryMainBindOutput,
} from "@oxagen/oxagen/contracts/repository.main.bind";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { createGitHubClient, getInstallationToken } from "@oxagen/github";
import type { GitHubRepoInfo } from "@oxagen/github";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { assertDataPlaneUsable, resolveDataPlane } from "@oxagen/tenancy";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  writeRepositoryHead,
  type BindableRepository,
  type RepositoryProvider,
} from "./repository.binding-write";
import {
  findWorkspaceGitLabConnection,
  gitlabNotConnected,
  readGitLabProject,
} from "./repository.gitlab-connection";
import {
  GITHUB_PROVIDER,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;
const PROVIDER = GITHUB_PROVIDER;

/**
 * What a 23505 from the heads table means, by constraint name. The partial
 * unique index refuses a second main head; the trigger
 * `repository_binding_heads_exclusive_main`
 * (20260918200000_repository_binding_heads_exclusive_across_roles.sql) raises
 * the same code under three names, one of them the index's own, so a handler
 * maps the racing case and the ordinary case to one sentence.
 */
const HEAD_CONFLICT_BY_CONSTRAINT: Readonly<
  Record<string, RepositoryHeadConflict>
> = {
  // The repository is another workspace's main. Raised by the index and by
  // the trigger for a main head written where a main head exists elsewhere.
  repository_binding_heads_main_repository_uq: "main_elsewhere",
  // A linked head written where a main head exists elsewhere: the same fact,
  // seen from the other side.
  repository_binding_heads_linked_is_main_elsewhere: "main_elsewhere",
  // A main head written where a linked head exists elsewhere.
  repository_binding_heads_main_is_linked_elsewhere: "linked_elsewhere",
};

/**
 * Which cross-workspace rule a head write broke: the repository is main in
 * another workspace, or it is linked in another workspace and was being
 * claimed as main.
 */
export type RepositoryHeadConflict = "main_elsewhere" | "linked_elsewhere";

/**
 * The refusal for a repository another workspace already steers by.
 *
 * It names NEITHER the organisation NOR the workspace holding the claim. The
 * index is global, so this fires across tenants, and "already the main
 * repository of Acme's workspace" would report the existence and repository
 * choices of one customer to another. The operator can see the claim from the
 * GitHub side, which is the side they control.
 */
export function repositoryClaimedElsewhere(fullName: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "main_repo_claimed",
    message: `${fullName} is already the main repository of another workspace. A repository steers exactly one workspace, because .oxagen/rules/ lives in the repository and two workspaces would write the same rule set. Unbind it there first, or bind a different repository here.`,
  });
}

/**
 * The refusal for a main claim on a repository another workspace has LINKED.
 *
 * A linked repository receives that workspace's repository-scoped Context PRs
 * (spec §10.1), and a main repository holds this workspace's `.oxagen/`
 * governance tree. Making one the other would put this workspace's governance
 * in a repository another workspace writes to. Names neither the organisation
 * nor the workspace holding the link, for the reason
 * `repositoryClaimedElsewhere` gives: the read that found it crossed tenants.
 */
export function repositoryLinkedElsewhere(fullName: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "repository_linked_elsewhere",
    message: `${fullName} is linked to another workspace, so it cannot be a main repository. A main repository holds a workspace's .oxagen/ governance tree, and a linked repository receives another workspace's Context PRs. Unlink it there first, or choose a different repository here.`,
  });
}

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
 * Turn a head write that lost to the store's cross-workspace rule into the
 * sentence the pre-check would have given, or rethrow anything else.
 */
export function rethrowHeadConflict(err: unknown, fullName: string): never {
  switch (repositoryHeadConflict(err)) {
    case "main_elsewhere":
      throw repositoryClaimedElsewhere(fullName);
    case "linked_elsewhere":
      throw repositoryLinkedElsewhere(fullName);
    case null:
      throw err;
  }
}

/**
 * Every head ANOTHER workspace holds for a repository, read across tenants
 * through `withSystemDb` because the heads table is tenant-scoped. This is
 * the pre-check every writer of a MAIN head runs for its sentence; the
 * trigger on the table is the guarantee, and `rethrowHeadConflict` gives a
 * lost race the same sentence.
 *
 * `workspaceId` is the writer's own workspace, excluded so a re-bind of the
 * repository a workspace already steers by is the repair path and not a
 * claim; `create_workspace` has no workspace yet and passes null.
 */
export async function headsHeldElsewhere(
  providerRepositoryId: string,
  workspaceId: string | null,
  provider: RepositoryProvider = PROVIDER,
): Promise<Array<{ role: string; workspaceId: string }>> {
  return withSystemDb((tx) =>
    tx
      .select({
        role: schema.repositoryBindingHeads.role,
        workspaceId: schema.repositoryBindingHeads.workspaceId,
      })
      .from(schema.repositoryBindingHeads)
      .where(
        and(
          eq(schema.repositoryBindingHeads.provider, provider),
          eq(
            schema.repositoryBindingHeads.providerRepositoryId,
            providerRepositoryId,
          ),
          ...(workspaceId === null
            ? []
            : [ne(schema.repositoryBindingHeads.workspaceId, workspaceId)]),
        ),
      ),
  );
}

/**
 * Refuse a main claim on a repository another workspace holds a head for. A
 * main head elsewhere wins the sentence over a linked one, matching the
 * trigger.
 */
export function assertNotHeldElsewhere(
  fullName: string,
  heads: ReadonlyArray<{ role: string }>,
): void {
  if (heads.some((h) => h.role === "main"))
    throw repositoryClaimedElsewhere(fullName);
  if (heads.length > 0) throw repositoryLinkedElsewhere(fullName);
}

/**
 * Refuse unless the global main-repository claim is actually knowable.
 *
 * `repository_binding_heads_main_repository_uq` is global only within ONE
 * Postgres. ADR-042 lets an organisation carry a dedicated plane, and
 * ingestion is tenant data such a plane holds, so the guard has two blind
 * spots and BOTH of them admit exactly the second claim it exists to refuse:
 *
 *   1. THIS organisation is dedicated. Its heads live on its own plane, where
 *      neither the shared index nor the shared read below can see them, and
 *      the claim it writes is invisible to every other tenant.
 *   2. ANY OTHER organisation is dedicated. Then a main head may already exist
 *      on that plane for this repository, and a shared-plane read returns
 *      nothing while the claim is real. Checking only the caller's own plane
 *      (which is all this did) let a shared-plane bind take a repository a
 *      dedicated tenant was already steered by.
 *
 * Both are refused rather than guessed, the way `billing.evidence_retention`
 * refuses the same ADR-042 gap. The real repair is a plane-aware global claim
 * check, which is a change to the store seam. No organisation is dedicated
 * today (ADR-042 §1 — absence of a row means shared, and the dedicated mode
 * has no customer), so nothing in service reaches either refusal.
 *
 * `org.data_planes` is itself always on the shared plane — a plane binding
 * cannot be stored on the plane it describes — so one `withSystemDb` read
 * answers (2) for every tenant at once.
 */
export async function assertGlobalClaimIsKnowable(
  orgId: string,
): Promise<void> {
  const plane = await resolveDataPlane(orgId, "postgres");
  // Throws DataPlaneUnavailableError for any binding that is not active.
  assertDataPlaneUsable(plane);
  if (plane.mode !== "shared") throw planeUnsupported();

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
      "repository.main.bind: refused — a dedicated Postgres plane exists, so the global main-repository claim cannot be checked",
    );
    throw planeUnsupported();
  }
}

function planeUnsupported(): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "main_repo_plane_unsupported",
    message:
      "Oxagen cannot yet prove this repository is not already the main repository of another workspace: a dedicated data plane is in use, and the uniqueness guard holds only within one database. Binding is refused rather than admitting a claim it cannot check.",
  });
}

/**
 * Re-ask which plane the organisation is on, uncached, from inside the
 * transaction that writes a main-repository claim. The reasoning — why it is
 * asked twice, why uncached, and the window it narrows without closing (#3288)
 * — is at the call site in the bind below. `create_workspace` writes the same
 * claim and asks the same question through this.
 */
export async function assertPlaneStillShared(scope: {
  orgId: string;
  workspaceId: string;
}): Promise<void> {
  const { loadDataPlaneBinding } = await import("@oxagen/database/data-plane");
  const planeNow = await loadDataPlaneBinding(scope.orgId, "postgres");
  assertDataPlaneUsable(planeNow);
  if (planeNow.mode !== "shared") {
    logger.warn(
      { orgId: scope.orgId, workspaceId: scope.workspaceId },
      "repository.main.bind: refused mid-transaction — the organisation's Postgres plane moved after the pre-check",
    );
    throw planeUnsupported();
  }
}

/**
 * The transaction-scoped advisory lock every writer of a workspace's binding
 * heads takes — `bind_main_repository`, `link_repository`,
 * `unlink_repository` — so each reads the heads the previous one committed.
 * The key keeps its original spelling so a deploy that mixes old and new
 * processes still serialises on one lock.
 */
export function workspaceRepositoriesLock(workspaceId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bind_main_repository:${workspaceId}`}::text, 0))`;
}

export interface MainRepositoryDeps {
  /** The repository as the installation sees it, or null when it cannot. */
  repository(
    installationId: string,
    owner: string,
    name: string,
  ): Promise<GitHubRepoInfo | null>;
  /**
   * The GitLab project the workspace connected under `projectPath`, read by id
   * through that connection's token. Defaults to the real reader; tests pass
   * a fake.
   */
  gitlabProject?(
    scope: { orgId: string; workspaceId: string },
    projectPath: string,
  ): Promise<BindTarget>;
}

/** What a bind writes against: the connection, the host and the repository. */
export interface BindTarget {
  provider: RepositoryProvider;
  connection: { id: string; publicId: string; status: string };
  repo: BindableRepository;
}

/**
 * The GitLab arm: the workspace's live GitLab connection for the path, and
 * the project read through its own token. A project the token can no longer
 * see is `repository_not_installed`, the refusal GitHub gives for a repository
 * its installation cannot see.
 */
export async function gitlabBindTarget(
  scope: { orgId: string; workspaceId: string },
  projectPath: string,
): Promise<BindTarget> {
  const connection = await findWorkspaceGitLabConnection(scope, {
    path: projectPath,
  });
  if (!connection) throw gitlabNotConnected();
  const repo = await readGitLabProject(scope, connection);
  if (!repo)
    throw new HandlerError({
      code: "not_found",
      reason: "repository_not_installed",
      message: `The GitLab token connected for ${projectPath} can no longer see the project`,
    });
  return {
    provider: "gitlab",
    connection: {
      id: connection.id,
      publicId: connection.publicId,
      status: connection.status,
    },
    repo,
  };
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
      // the repository answers 404, which is the refusal this write names.
      if (
        err instanceof Error &&
        err.message.startsWith("GitHub API error 404")
      )
        return null;
      throw err;
    }
  },
};

export function createMainRepositoryBindHandler(
  deps: MainRepositoryDeps,
): CapabilityHandler<typeof repositoryMainBind> {
  return async (input, ctx): Promise<RepositoryMainBindOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: [...MAIN_REPOSITORY_ROLES] },
    );
    // assertOrgRole refused a call with no acting user.
    const userId = actingUserId as string;
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const now = new Date();

    let target: BindTarget;
    if (input.provider === "gitlab") {
      target = await (deps.gitlabProject ?? gitlabBindTarget)(
        scope,
        input.projectPath,
      );
    } else {
      const installation = await resolveWorkspaceGithubInstallation(scope);
      if (!installation) {
        throw new HandlerError({
          code: "conflict",
          reason: "github_not_connected",
          message:
            "This workspace has no GitHub App installation attached; connect GitHub first",
        });
      }
      const github = await deps.repository(
        installation.installationId,
        input.owner,
        input.name,
      );
      if (!github) {
        throw new HandlerError({
          code: "not_found",
          reason: "repository_not_installed",
          message: `The GitHub App installation on this workspace cannot see ${input.owner}/${input.name}`,
        });
      }
      target = { provider: PROVIDER, connection: installation, repo: github };
    }
    const { connection, repo, provider } = target;

    // ── Is this repository already some other workspace's main repository? ───
    //
    // The read that decides this cannot run inside the transaction below: the
    // heads table is tenant-scoped and RLS narrows every read there to THIS
    // workspace, which is exactly why the existing advisory lock could never
    // see a claim made elsewhere. `withSystemDb` is the seam that crosses it.
    //
    // This is for the MESSAGE, not for the guarantee. Two workspaces binding
    // the same repository at the same instant both pass this read and one of
    // them then violates `repository_binding_heads_main_repository_uq`; the
    // advisory lock does not serialise them either, because it is keyed on the
    // workspace and theirs differ. The index is the guarantee, this read is how
    // the ordinary case gets a sentence instead of a constraint name, and the
    // catch below is how the racing case gets the same sentence.
    //
    // Both roles count. A repository another workspace has LINKED cannot
    // become this workspace's main either: its `.oxagen/` tree would then sit
    // in a repository that workspace opens Context PRs on. Not this
    // workspace's own heads: re-binding a repository this workspace already
    // steers is the idempotent/repair path below, not a claim.
    await assertGlobalClaimIsKnowable(ctx.orgId);
    const heldElsewhere = await headsHeldElsewhere(
      repo.id,
      ctx.workspaceId,
      provider,
    );
    if (heldElsewhere.length > 0) {
      logger.warn(
        {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          repository: repo.fullName,
        },
        "repository.main.bind: refused — another workspace already holds this repository",
      );
      assertNotHeldElsewhere(repo.fullName, heldElsewhere);
    }

    let result: {
      bindingPublicId: string;
      boundAt: Date;
      provisionalClosed: boolean;
    };
    try {
      result = await withTenantDb(async (tx) => {
        // A second bind in this workspace waits here until the first commits,
        // then reads the head it wrote.
        await tx.execute(workspaceRepositoriesLock(scope.workspaceId));

        // Re-ask which plane this organisation is on, INSIDE the transaction
        // that writes.
        //
        // The check above ran before `withTenantDb` opened, and `withTenantDb`
        // resolves the plane again for itself. Between those two resolutions
        // the organisation can be moved from shared to dedicated — that is an
        // ordinary operator action, not a rare interleaving — and the write
        // would then land on the dedicated plane despite a refusal that had
        // already decided it must not. The claim written there is invisible to
        // the shared global index, so another workspace binds the same
        // repository and the guarantee is gone, silently, with no error on
        // either path.
        //
        // Re-validating here narrows the window: a plane that moved raises,
        // the transaction rolls back, and nothing is claimed. It is a read of
        // `org.data_planes` on the shared plane, so it costs one round trip
        // and cannot itself be affected by the move it is detecting.
        //
        // It does NOT close the window, and the difference matters to anyone
        // reasoning about this code. `loadDataPlaneBinding` opens its own
        // `withSystemDb` transaction, so this read is not atomic with the
        // surrounding tenant `tx`: a `set_data_plane` that commits after this
        // returns `shared` but before the head insert still leaves the insert
        // in the shared database while the organisation routes elsewhere —
        // an orphaned global claim the organisation cannot read and that
        // blocks other workspaces. Closing it needs a lock or other
        // coordination spanning the plane decision and the claim write, which
        // is #3288.
        //
        // `loadDataPlaneBinding`, NOT `resolveDataPlane`: the resolver caches
        // per process and `set_data_plane` invalidates only the process it
        // ran in, so within the cache window this re-ask would hand back the
        // very same stale `shared` answer the pre-check already had — and
        // check nothing at all. The uncached read is the whole point of
        // asking twice.
        await assertPlaneStillShared(scope);
        const heads = await tx
          .select({
            id: schema.repositoryBindingHeads.id,
            role: schema.repositoryBindingHeads.role,
            provider: schema.repositoryBindingHeads.provider,
            connectionId: schema.repositoryBindingHeads.connectionId,
            providerRepositoryId:
              schema.repositoryBindingHeads.providerRepositoryId,
            currentBindingId: schema.repositoryBindingHeads.currentBindingId,
          })
          .from(schema.repositoryBindingHeads)
          .where(
            and(
              eq(schema.repositoryBindingHeads.orgId, scope.orgId),
              eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
            ),
          );
        // EVERY head of this workspace, of either role, because the two
        // questions decided from this read need different subsets.
        //
        // "Does this workspace already steer by a DIFFERENT repository" is
        // about MAIN heads only. A head the exclusivity migration demoted to
        // 'linked' is one this workspace is no longer steered by, and counting
        // it would refuse `main_repo_bound` to a workspace that has no main
        // repository at all, leaving it no way to bind one.
        //
        // "Is there already a head for THIS repository" is about any role. A
        // linked head for the repository being bound is promoted below, and
        // reading only main heads would miss it and then write a second head
        // for one (connection, repository) — refused by
        // `repository_binding_heads_repository_uq` — and a second version-1
        // binding, refused by `repository_bindings_repository_version_uq`.
        // Neither is a cross-workspace claim, so `rethrowHeadConflict` passes
        // them through and the operator gets a 500 on the only move that would
        // have given their workspace a main repository back.
        // A repository is its host plus the host's id: a GitLab project and
        // a GitHub repository can carry the same number.
        const isThis = (h: {
          provider: string;
          providerRepositoryId: string;
        }) => h.provider === provider && h.providerRepositoryId === repo.id;
        const same = heads.find(isThis);
        if (heads.some((h) => h.role === "main" && !isThis(h))) {
          throw new HandlerError({
            code: "conflict",
            reason: "main_repo_bound",
            message: "This workspace already binds a different repository",
          });
        }

        let bindingPublicId: string;
        let boundAt: Date;
        if (same) {
          const [existing] = await tx
            .select({
              id: schema.repositoryBindings.id,
              publicId: schema.repositoryBindings.publicId,
              createdAt: schema.repositoryBindings.createdAt,
              version: schema.repositoryBindings.version,
              connectionId: schema.repositoryBindings.connectionId,
              providerOwner: schema.repositoryBindings.providerOwner,
              providerName: schema.repositoryBindings.providerName,
              providerFullName: schema.repositoryBindings.providerFullName,
              configuredDefaultRef:
                schema.repositoryBindings.configuredDefaultRef,
            })
            .from(schema.repositoryBindings)
            .where(eq(schema.repositoryBindings.id, same.currentBindingId))
            .limit(1);
          if (!existing) {
            throw new Error(
              "repository_binding_heads names a binding that does not exist",
            );
          }
          // What a binding version MEANS, from the table's own header comment:
          // "a rename or a reconfigured default ref". So a re-bind of the same
          // repository writes a successor whenever any fact the binding records
          // has moved — not only when the connection has.
          //
          // Comparing only the connection (which is all this did) left the
          // approved ref with no way to change. Steering resolves
          // `defaultBranch` from `configuredDefaultRef` and `assertProductionBase`
          // refuses any Context PR whose base is not it, so once GitHub's default
          // branch was renamed the workspace could open nothing — and the repair
          // the UI offers, binding the same repository again, wrote nothing and
          // changed nothing. A silent retarget was traded for a hard stop with no
          // exit. `set_main_repository`, which the repository-binding spec names
          // for this, is a spec entry with no contract and no handler.
          //
          // Re-approving the SAME repository stays inside this capability's
          // authority for the reason the connection-repair case already argues:
          // the `main_repo_bound` conflict above governs moving to a DIFFERENT
          // repository and still fires for one. And the ref still only ever moves
          // on a deliberate operator re-bind, never from live GitHub state, which
          // is the invariant steering was fixed to hold.
          const drifted =
            same.connectionId !== connection.id ||
            existing.connectionId !== connection.id ||
            existing.providerOwner !== repo.owner ||
            existing.providerName !== repo.name ||
            existing.providerFullName !== repo.fullName ||
            existing.configuredDefaultRef !== repo.defaultBranch;
          // A LINKED head for this repository is promoted rather than
          // duplicated. The workspace can already see the repository; this call
          // is the operator deciding it should steer by it, which is the same
          // decision as a first bind. The UPDATE fires the store's exclusivity
          // trigger (it is `BEFORE INSERT OR UPDATE OF role`), so a repository
          // another workspace holds still loses here, with the same sentence.
          const promote = same.role !== "main";
          if (!drifted && !promote) {
            // Nothing has moved, so nothing is written. The first bind's identity
            // is the answer.
            bindingPublicId = existing.publicId;
            boundAt = existing.createdAt;
          } else if (!drifted) {
            // The binding records nothing new, so no version is written; only
            // the role moves. `boundAt` is now, because now is when this
            // repository became the one that steers the workspace.
            await tx
              .update(schema.repositoryBindingHeads)
              .set({ role: "main", updatedAt: now })
              .where(eq(schema.repositoryBindingHeads.id, same.id));
            bindingPublicId = existing.publicId;
            boundAt = now;
          } else {
            // Same repository, something the binding records has moved. The
            // successor carries every such fact forward together — owner, name,
            // full name, approved ref and connection — because they are read as
            // one record and a version that updated only some of them would put
            // the binding into a state no single observation ever produced.
            //
            // The connection case is the subtlest of them, so it keeps its
            // reasoning here. A DIFFERENT connection means the head still points
            // at one this workspace no longer acts through. That is the
            // reconnect state: `delete_connection` leaves the old row at
            // `status = 'deleting'` with a null `deleted_at`, and the install
            // callback's attach then inserts a fresh connection because the
            // retired one is not live. Every reader that joins the head back to
            // its connection — `readGitHubConnection`, the one steering resolves
            // the main repository through — then finds nothing, and steering goes
            // silently off with the head still claiming a repository is bound.
            //
            // The conceptual line: re-binding the SAME repository through a
            // replacement connection is a REPAIR, not a change of main repo. The
            // `main_repo_bound` conflict above (spec §10.1, an org owner's
            // decision) governs moving to a DIFFERENT repository and still fires
            // for one, unchanged. Which repository is main never moves here; only
            // what this workspace records about it does.
            //
            // Safe because `deps.repository` already refused
            // `repository_not_installed` unless this installation can reach this
            // repository, so a repair can never point the workspace at a
            // repository the replacement installation cannot read.
            //
            // A binding is immutable and versioned, so the move INSERTS the next
            // version naming the one it supersedes (the table's
            // `repository_bindings_supersedes_check` requires exactly that) and
            // leaves the superseded row untouched. The head is a pointer, not
            // evidence, so it is updated in place: a second head row would leave
            // two heads for one workspace repository, and the reader that took
            // the wrong one would disagree with the binding about the connection.
            const [successor] = await tx
              .insert(schema.repositoryBindings)
              .values({
                orgId: scope.orgId,
                workspaceId: scope.workspaceId,
                connectionId: connection.id,
                provider,
                providerRepositoryId: repo.id,
                providerOwner: repo.owner,
                providerName: repo.name,
                providerFullName: repo.fullName,
                configuredDefaultRef: repo.defaultBranch,
                observedAt: now,
                version: existing.version + 1,
                supersedesBindingId: existing.id,
                createdAt: now,
                createdById: userId,
              })
              .returning({
                id: schema.repositoryBindings.id,
                publicId: schema.repositoryBindings.publicId,
              });
            if (!successor)
              throw new Error("repository_bindings insert returned no row");
            await tx
              .update(schema.repositoryBindingHeads)
              .set({
                connectionId: connection.id,
                currentBindingId: successor.id,
                // Carried with the rest: a linked head being promoted in the
                // same statement that moves its binding forward.
                role: "main",
                updatedAt: now,
              })
              .where(eq(schema.repositoryBindingHeads.id, same.id));
            bindingPublicId = successor.publicId;
            // The successor's `created_at` is the `now` it was just inserted with.
            boundAt = now;
          }
        } else {
          // Through the one head writer, not a local version-1 insert. This
          // workspace may already HOLD a binding version for the repository
          // with no head on it — a link that was unlinked keeps its versions,
          // because admitted runs cite them — and a second version 1 for the
          // same (connection, repository) is refused by
          // `repository_bindings_repository_version_uq`, which reaches the
          // operator as a 500 rather than as anything they can act on.
          // `writeRepositoryHead` reuses that retained version, or supersedes
          // it when something it records has moved, and writes the
          // `role = 'main'` head. The role is written out there rather than
          // left to the column default, because which role a head carries is
          // the whole question the store's exclusivity rule answers.
          const written = await writeRepositoryHead(tx, {
            scope,
            connectionId: connection.id,
            repo,
            role: "main",
            provider,
            userId,
            now,
          });
          bindingPublicId = written.bindingPublicId;
          boundAt = now;
        }

        if (connection.status !== "connected") {
          await tx
            .update(schema.sourceConnections)
            .set({ status: "connected", updatedAt: now })
            .where(eq(schema.sourceConnections.id, connection.id));
        }

        const closed = await tx
          .update(schema.onboardingState)
          .set({ mainRepoBoundAt: now, updatedAt: now })
          .where(
            and(
              eq(schema.onboardingState.orgId, scope.orgId),
              eq(schema.onboardingState.workspaceId, scope.workspaceId),
              isNull(schema.onboardingState.mainRepoBoundAt),
            ),
          )
          .returning({ orgId: schema.onboardingState.orgId });

        return {
          bindingPublicId,
          boundAt,
          provisionalClosed: closed.length > 0,
        };
      });
    } catch (err) {
      // The window the pre-check above cannot close. Two workspaces writing a
      // head for the same repository concurrently both read nothing held and
      // both proceed; the workspace lock does not serialise them, because
      // theirs differ. The trigger's repository-keyed lock does, and the loser
      // gets a 23505 with a constraint name. This turns it into the sentence
      // the ordinary path gives rather than an `internal_error`.
      if (repositoryHeadConflict(err) !== null) {
        logger.warn(
          {
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            repository: repo.fullName,
          },
          "repository.main.bind: lost the race for a main repository claim",
        );
      }
      rethrowHeadConflict(err, repo.fullName);
    }

    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        repository: repo.fullName,
        bindingId: result.bindingPublicId,
        provisionalClosed: result.provisionalClosed,
      },
      "repository.main.bind: main repository bound",
    );

    return {
      bindingId: result.bindingPublicId,
      connectionId: connection.publicId,
      provider,
      fullName: repo.fullName,
      defaultRef: repo.defaultBranch,
      boundAt: result.boundAt.toISOString(),
      provisionalClosed: result.provisionalClosed,
    };
  };
}

export const repositoryMainBindHandler = createMainRepositoryBindHandler(
  githubMainRepositoryDeps,
);
