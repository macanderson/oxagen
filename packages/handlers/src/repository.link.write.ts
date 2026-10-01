// repository.link.write.ts: the one writer of a linked head (ADR-212).
//
// `link_repository` no longer writes a head. It opens a steering PR that adds
// the repository to workspace.toml, and the steering sync writes the head once
// that PR merges. Both callers apply the same rules, so they live here:
//
//   1. The installation: the workspace's GitHub connection, through the one
//      shared resolver. Nobody names an installation.
//   2. The repository, read through that installation's token. One it cannot
//      see is `not_found: repository_not_installed`.
//   3. Is it another workspace's steering repository? Refused as
//      `main_repo_claimed`. Another workspace's steering repository holds
//      that workspace's steering records, and linking it here would give
//      this workspace a way into them. The heads table is tenant-scoped, so the
//      read crosses through `withSystemDb`. When a dedicated data plane makes
//      the answer unknowable, the write is refused rather than guessed.
//   4. This workspace's heads decide `main_repo_unbound` (no steering
//      repository to hold workspace.toml), `main_repo` (it is the steering
//      repository here), and `repository_already_linked`.
//   5. The head, written under the workspace's repository lock, after an
//      uncached re-read of the organization's data plane
//      (`assertPlaneStillShared`): a plane that moved since step 3 would put
//      the head where the trigger cannot see it. The trigger
//      `repository_binding_heads_exclusive_main` serialises it against a
//      concurrent steering claim elsewhere, and a lost race maps back to
//      `main_repo_claimed`. A connection still at `pending_setup` moves to
//      `connected` in the same transaction.
//
// `link_repository` runs steps 1 to 4 before it opens the steering PR, so a
// PR that could never take effect is refused up front. The sync runs all
// five when the merged workspace.toml lists the repository.
import type { GitHubRepoInfo } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import { logger } from "./logger";
import {
  assertGlobalClaimIsKnowable,
  assertPlaneStillShared,
  type MainRepositoryDeps,
  repositoryHeadConflict,
  type WrittenRepositoryHead,
  workspaceRepositoriesLock,
  writeRepositoryHead,
} from "./repository.binding-write";
import {
  GITHUB_PROVIDER,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";

type Scope = { orgId: string; workspaceId: string };

/** What a linked head is written against. */
export interface LinkTarget {
  connection: { id: string; publicId: string };
  repo: GitHubRepoInfo;
}

/**
 * The refusal for another workspace's steering repository. It names neither
 * the organization nor the workspace holding the claim, because the read that
 * finds it crosses tenants.
 */
function mainRepoClaimed(fullName: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "main_repo_claimed",
    message: `${fullName} is the steering repository of another workspace. Its steering record governs that workspace, so it cannot be linked here.`,
  });
}

/**
 * Steps 1 to 3: the installation, the repository, and the cross-workspace
 * steering claim. Writes nothing.
 */
export async function resolveLinkTarget(
  scope: Scope,
  owner: string,
  name: string,
  deps: Pick<MainRepositoryDeps, "repository">,
): Promise<LinkTarget> {
  const connection = await resolveWorkspaceGithubInstallation(scope);
  if (!connection) {
    throw new HandlerError({
      code: "conflict",
      reason: "github_not_connected",
      message:
        "This workspace has no GitHub App installation attached. Connect GitHub first.",
    });
  }

  const repo = await deps.repository(connection.installationId, owner, name);
  if (!repo) {
    throw new HandlerError({
      code: "not_found",
      reason: "repository_not_installed",
      message: `The GitHub App installation on this workspace cannot see ${owner}/${name}`,
    });
  }

  await assertGlobalClaimIsKnowable(scope.orgId);
  // tenancy: a global cross-tenant read, filtered to this provider
  // repository id and the steering roles in other workspaces. It returns
  // only whether such a head exists, never another tenant's row.
  const steeringElsewhere = await withSystemDb((tx) =>
    tx
      .select({ id: schema.repositoryBindingHeads.id })
      .from(schema.repositoryBindingHeads)
      .where(
        and(
          eq(schema.repositoryBindingHeads.provider, GITHUB_PROVIDER),
          eq(schema.repositoryBindingHeads.providerRepositoryId, repo.id),
          inArray(
            schema.repositoryBindingHeads.role,
            schema.STEERING_HEAD_ROLES,
          ),
          ne(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  if (steeringElsewhere.length > 0) {
    logger.warn(
      { ...scope, repository: repo.fullName },
      "repository.link: refused. The repository is another workspace's steering repository.",
    );
    throw mainRepoClaimed(repo.fullName);
  }

  return {
    connection: { id: connection.id, publicId: connection.publicId },
    repo,
  };
}

/**
 * Step 4: refuse unless this workspace may gain a linked head for `repo`.
 * The caller supplies the transaction, and holds the workspace lock when it
 * goes on to write.
 */
export async function assertLinkAllowed(
  tx: Tx,
  scope: Scope,
  repo: Pick<GitHubRepoInfo, "id" | "fullName">,
): Promise<void> {
  // This workspace's steering head, on whichever host it lives, and its
  // GitHub heads for THIS repository, in one read.
  const heads = await tx
    .select({
      role: schema.repositoryBindingHeads.role,
      provider: schema.repositoryBindingHeads.provider,
      providerRepositoryId: schema.repositoryBindingHeads.providerRepositoryId,
    })
    .from(schema.repositoryBindingHeads)
    .where(
      and(
        eq(schema.repositoryBindingHeads.orgId, scope.orgId),
        eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
        or(
          and(
            eq(schema.repositoryBindingHeads.provider, GITHUB_PROVIDER),
            eq(schema.repositoryBindingHeads.providerRepositoryId, repo.id),
          ),
          inArray(
            schema.repositoryBindingHeads.role,
            schema.STEERING_HEAD_ROLES,
          ),
        ),
      ),
    );
  // workspace.toml lives on the steering repository. Without one there is no
  // steering record to list the link in.
  if (!heads.some((h) => schema.isSteeringHeadRole(h.role))) {
    throw new HandlerError({
      code: "conflict",
      reason: "main_repo_unbound",
      message:
        "This workspace has no steering repository yet. Its workspace.toml lists the linked repositories, so a link waits for it. Oxagen creates the steering repository after the organization connects GitHub or GitLab.",
    });
  }
  const same = heads.filter(
    (h) => h.provider === GITHUB_PROVIDER && h.providerRepositoryId === repo.id,
  );
  if (same.some((h) => schema.isSteeringHeadRole(h.role))) {
    throw new HandlerError({
      code: "conflict",
      reason: "main_repo",
      message: `${repo.fullName} is this workspace's steering repository, so it cannot also be linked`,
    });
  }
  if (same.length > 0) {
    throw new HandlerError({
      code: "conflict",
      reason: "repository_already_linked",
      message: `${repo.fullName} is already linked to this workspace`,
    });
  }
}

/**
 * The install callback and `attach_github_installation` write the workspace's
 * GitHub connection at `pending_setup`. That status keeps an installation with
 * nothing bound through it out of the ingestion poller, which claims only
 * `connected` rows. Once a linked head is written on the connection, a
 * repository is bound through it, so it moves to `connected`, and the readers
 * that mint a token through `resolveGitHubToken` can use it. Only
 * `pending_setup` moves. A connection in any other status keeps it.
 */
async function promotePendingConnection(
  tx: Tx,
  connectionId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.sourceConnections)
    .set({ status: "connected", updatedAt: now })
    .where(
      and(
        eq(schema.sourceConnections.id, connectionId),
        eq(schema.sourceConnections.status, "pending_setup"),
      ),
    );
}

/**
 * Step 5: write the linked head under the workspace lock. `userId` is null
 * when the steering sync writes it: the person who merged the steering PR is
 * the host's fact, not an Oxagen user.
 */
export async function writeLinkedHead(
  scope: Scope,
  target: LinkTarget,
  args: { userId: string | null; now: Date },
): Promise<WrittenRepositoryHead> {
  try {
    return await withTenantDb(async (tx) => {
      await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
      // The plane the pre-check read may have moved since. Ask again,
      // uncached, before the head is written (#3340 finding 1).
      await assertPlaneStillShared(scope);
      await assertLinkAllowed(tx, scope, target.repo);
      const written = await writeRepositoryHead(tx, {
        scope,
        connectionId: target.connection.id,
        repo: target.repo,
        role: "linked",
        userId: args.userId,
        now: args.now,
      });
      await promotePendingConnection(tx, target.connection.id, args.now);
      return written;
    });
  } catch (err) {
    // The window the pre-check cannot close: a steering claim on this
    // repository that committed elsewhere after the read. The trigger's
    // repository-keyed lock serialised the two writes and refused this one
    // by constraint name.
    if (repositoryHeadConflict(err) === "main_elsewhere") {
      logger.warn(
        { ...scope, repository: target.repo.fullName },
        "repository.link: lost the race to a steering repository claim elsewhere",
      );
      throw mainRepoClaimed(target.repo.fullName);
    }
    throw err;
  }
}

/** Steps 1 to 5 for one repository: what the steering sync runs per listed entry. */
export async function linkRepositoryHead(
  scope: Scope,
  repository: { owner: string; name: string },
  args: { userId: string | null; now: Date },
  deps: Pick<MainRepositoryDeps, "repository">,
): Promise<WrittenRepositoryHead & { fullName: string }> {
  const target = await resolveLinkTarget(
    scope,
    repository.owner,
    repository.name,
    deps,
  );
  const written = await writeLinkedHead(scope, target, args);
  return { ...written, fullName: target.repo.fullName };
}
