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
//   4. Exclusivity ACROSS workspaces: is this repository already the main
//      repository of a different one? The heads table is tenant-scoped, so
//      that read crosses the boundary through `withSystemDb` — the advisory
//      lock in step 5 never could, being keyed on this workspace alone. The
//      guarantee is `repository_binding_heads_main_repository_uq`, a unique
//      index on (provider, provider_repository_id) WHERE role = 'main' that
//      carries no org or workspace in its key; this read exists so the
//      ordinary case refuses with a sentence, and the catch around step 5 so
//      the racing case refuses with the same one.
//   5. One transaction, holding a transaction-scoped advisory lock on the
//      workspace so two binds IN THIS WORKSPACE read the heads one after the
//      other: the workspace's current binding heads decide idempotent /
//      repair (the same repository through a replacement connection, which
//      supersedes the binding onto it) / conflict; else the version-1 binding
//      and its head, the connection marked connected, and the gate's
//      provisional window closed when this workspace is the gate's. No table
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
  GITHUB_PROVIDER,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;
const PROVIDER = GITHUB_PROVIDER;

/** The partial unique index that holds one main repository per repository. */
const MAIN_REPOSITORY_CONSTRAINT =
  "repository_binding_heads_main_repository_uq";

/**
 * The refusal for a repository another workspace already steers by.
 *
 * It names NEITHER the organisation NOR the workspace holding the claim. The
 * index is global, so this fires across tenants, and "already the main
 * repository of Acme's workspace" would report the existence and repository
 * choices of one customer to another. The operator can see the claim from the
 * GitHub side, which is the side they control.
 */
function repositoryClaimedElsewhere(fullName: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "main_repo_claimed",
    message: `${fullName} is already the main repository of another workspace. A repository steers exactly one workspace, because .oxagen/rules/ lives in the repository and two workspaces would write the same rule set. Unbind it there first, or bind a different repository here.`,
  });
}

/**
 * True for a violation of the main-repository index specifically.
 *
 * Matched on the constraint NAME rather than on 23505 alone: this insert can
 * also violate `repository_binding_heads_repository_uq`, which means something
 * else entirely, and reporting that as "claimed by another workspace" would
 * send the operator to look for a workspace that does not exist. Postgres
 * carries the name on the error; the driver nests it under `cause`.
 */
function isMainRepositoryConflict(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e != null && hops < 5; hops++) {
    const row = e as {
      code?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (
      row.code === "23505" &&
      row.constraint_name === MAIN_REPOSITORY_CONSTRAINT
    ) {
      return true;
    }
    e = row.cause;
  }
  return false;
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
async function assertGlobalClaimIsKnowable(orgId: string): Promise<void> {
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

export interface MainRepositoryDeps {
  /** The repository as the installation sees it, or null when it cannot. */
  repository(
    installationId: string,
    owner: string,
    name: string,
  ): Promise<GitHubRepoInfo | null>;
}

const githubMainRepositoryDeps: MainRepositoryDeps = {
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

    const connection = await resolveWorkspaceGithubInstallation(scope);
    if (!connection) {
      throw new HandlerError({
        code: "conflict",
        reason: "github_not_connected",
        message:
          "This workspace has no GitHub App installation attached; connect GitHub first",
      });
    }

    const repo = await deps.repository(
      connection.installationId,
      input.owner,
      input.name,
    );
    if (!repo) {
      throw new HandlerError({
        code: "not_found",
        reason: "repository_not_installed",
        message: `The GitHub App installation on this workspace cannot see ${input.owner}/${input.name}`,
      });
    }

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
    await assertGlobalClaimIsKnowable(ctx.orgId);
    const claimedElsewhere = await withSystemDb((tx) =>
      tx
        .select({ workspaceId: schema.repositoryBindingHeads.workspaceId })
        .from(schema.repositoryBindingHeads)
        .where(
          and(
            eq(schema.repositoryBindingHeads.provider, PROVIDER),
            eq(schema.repositoryBindingHeads.providerRepositoryId, repo.id),
            eq(schema.repositoryBindingHeads.role, "main"),
            // Not this workspace: re-binding a repository this workspace
            // already steers is the idempotent/repair path below, not a claim.
            ne(schema.repositoryBindingHeads.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1),
    );
    if (claimedElsewhere.length > 0) {
      logger.warn(
        {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          repository: repo.fullName,
        },
        "repository.main.bind: refused — repository is already a main repository elsewhere",
      );
      throw repositoryClaimedElsewhere(repo.fullName);
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
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bind_main_repository:${scope.workspaceId}`}::text, 0))`,
        );

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
        const { loadDataPlaneBinding } = await import(
          "@oxagen/database/data-plane"
        );
        const planeNow = await loadDataPlaneBinding(scope.orgId, "postgres");
        assertDataPlaneUsable(planeNow);
        if (planeNow.mode !== "shared") {
          logger.warn(
            { orgId: scope.orgId, workspaceId: scope.workspaceId },
            "repository.main.bind: refused mid-transaction — the organisation's Postgres plane moved after the pre-check",
          );
          throw planeUnsupported();
        }
        const heads = await tx
          .select({
            id: schema.repositoryBindingHeads.id,
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
              // Only a MAIN head answers "does this workspace already bind a
              // different repository". A head the exclusivity migration
              // demoted to 'linked' is one this workspace is no longer steered
              // by, and counting it would refuse `main_repo_bound` to a
              // workspace that has no main repository at all — leaving it with
              // no way to bind one.
              eq(schema.repositoryBindingHeads.role, "main"),
            ),
          );
        const same = heads.find((h) => h.providerRepositoryId === repo.id);
        if (!same && heads.length > 0) {
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
          if (!drifted) {
            // Nothing has moved, so nothing is written. The first bind's identity
            // is the answer.
            bindingPublicId = existing.publicId;
            boundAt = existing.createdAt;
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
                provider: PROVIDER,
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
                updatedAt: now,
              })
              .where(eq(schema.repositoryBindingHeads.id, same.id));
            bindingPublicId = successor.publicId;
            // The successor's `created_at` is the `now` it was just inserted with.
            boundAt = now;
          }
        } else {
          const [binding] = await tx
            .insert(schema.repositoryBindings)
            .values({
              orgId: scope.orgId,
              workspaceId: scope.workspaceId,
              connectionId: connection.id,
              provider: PROVIDER,
              providerRepositoryId: repo.id,
              providerOwner: repo.owner,
              providerName: repo.name,
              providerFullName: repo.fullName,
              configuredDefaultRef: repo.defaultBranch,
              observedAt: now,
              version: 1,
              supersedesBindingId: null,
              createdAt: now,
              createdById: userId,
            })
            .returning({
              id: schema.repositoryBindings.id,
              publicId: schema.repositoryBindings.publicId,
            });
          if (!binding)
            throw new Error("repository_bindings insert returned no row");
          await tx.insert(schema.repositoryBindingHeads).values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            connectionId: connection.id,
            provider: PROVIDER,
            providerRepositoryId: repo.id,
            currentBindingId: binding.id,
            // This capability binds the MAIN repository — the one whose
            // `.oxagen/rules/` steers the workspace — so it is what the
            // exclusivity index applies to. Written out rather than left to the
            // column default, because which role a head carries is the whole
            // question that index answers.
            role: "main",
            createdAt: now,
            updatedAt: now,
          });
          bindingPublicId = binding.publicId;
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
      // The window the pre-check above cannot close. Two workspaces binding the
      // same repository concurrently both read no claim and both proceed; the
      // advisory lock does not serialise them, because it is keyed on the
      // workspace and theirs differ. One of them then loses to the unique
      // index, and this turns that into the same sentence the ordinary path
      // gives rather than an unhandled 23505 surfacing as `internal_error`.
      if (isMainRepositoryConflict(err)) {
        logger.warn(
          {
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            repository: repo.fullName,
          },
          "repository.main.bind: lost the race for a main repository claim",
        );
        throw repositoryClaimedElsewhere(repo.fullName);
      }
      throw err;
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
