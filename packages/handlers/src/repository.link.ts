// repository.link.ts — `link_repository` (Mission Control spec §10.1; ADR-099).
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin, or the workspace's Owner
//      (INV-29).
//   2. The installation: the workspace's GitHub connection, through the one
//      shared resolver `bind_main_repository` uses. The caller never names one.
//   3. The repository, read through the installation's token. One it cannot
//      see is `not_found: repository_not_installed`.
//   4. Is it ANOTHER workspace's main repository? Refused, `main_repo_claimed`:
//      a linked repository receives this workspace's repository-scoped Context
//      PRs (§10.1), and another workspace's main repository holds that
//      workspace's `.oxagen/` governance tree. The heads table is
//      tenant-scoped, so the read crosses through `withSystemDb`, and — like
//      the main-repository claim — it is refused rather than guessed when a
//      dedicated data plane makes the answer unknowable.
//   5. One transaction under the workspace's repository lock: this
//      workspace's heads decide `main_repo_unbound` (no main head yet: the
//      organisation's first workspace is written without one, and GitHub can
//      be attached to it before `bind_main_repository` runs, so a link here
//      would be a linked repository with no main to be second to),
//      `main_repo` (it is the main repository here) and
//      `repository_already_linked`; else a binding (reused or superseded
//      when this connection bound the repository before) and a
//      `role = 'linked'` head. The store's trigger
//      `repository_binding_heads_exclusive_main` serialises this write
//      against a concurrent main claim elsewhere on a repository-keyed lock,
//      and a lost race is mapped back to `main_repo_claimed`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryLink,
  type RepositoryLinkOutput,
} from "@oxagen/oxagen/contracts/repository.link";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq, ne, or } from "drizzle-orm";
import { logger } from "./logger";
import { writeRepositoryHead } from "./repository.binding-write";
import {
  GITHUB_PROVIDER,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";
import {
  assertGlobalClaimIsKnowable,
  githubMainRepositoryDeps,
  repositoryHeadConflict,
  workspaceRepositoriesLock,
  type MainRepositoryDeps,
} from "./repository.main.bind";

/**
 * The refusal for another workspace's main repository. Names neither the
 * organisation nor the workspace holding the claim: the read that finds it
 * crosses tenants (see `repositoryClaimedElsewhere`).
 */
function mainRepoClaimed(fullName: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "main_repo_claimed",
    message: `${fullName} is the main repository of another workspace. Its .oxagen/ tree governs that workspace, so it cannot be linked here.`,
  });
}

export function createRepositoryLinkHandler(
  deps: MainRepositoryDeps,
): CapabilityHandler<typeof repositoryLink> {
  return async (input, ctx): Promise<RepositoryLinkOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    const userId = actingUserId as string;
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

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

    await assertGlobalClaimIsKnowable(ctx.orgId);
    const mainElsewhere = await withSystemDb((tx) =>
      tx
        .select({ id: schema.repositoryBindingHeads.id })
        .from(schema.repositoryBindingHeads)
        .where(
          and(
            eq(schema.repositoryBindingHeads.provider, GITHUB_PROVIDER),
            eq(schema.repositoryBindingHeads.providerRepositoryId, repo.id),
            eq(schema.repositoryBindingHeads.role, "main"),
            ne(schema.repositoryBindingHeads.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1),
    );
    if (mainElsewhere.length > 0) {
      logger.warn(
        { ...scope, repository: repo.fullName },
        "repository.link: refused — repository is another workspace's main repository",
      );
      throw mainRepoClaimed(repo.fullName);
    }

    const now = new Date();
    let written: Awaited<ReturnType<typeof writeRepositoryHead>>;
    try {
      written = await withTenantDb(async (tx) => {
        await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
        // This workspace's main head, whichever repository it names, and its
        // heads for THIS repository, in one read.
        const heads = await tx
          .select({
            role: schema.repositoryBindingHeads.role,
            providerRepositoryId:
              schema.repositoryBindingHeads.providerRepositoryId,
          })
          .from(schema.repositoryBindingHeads)
          .where(
            and(
              eq(schema.repositoryBindingHeads.orgId, scope.orgId),
              eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
              eq(schema.repositoryBindingHeads.provider, GITHUB_PROVIDER),
              or(
                eq(schema.repositoryBindingHeads.providerRepositoryId, repo.id),
                eq(schema.repositoryBindingHeads.role, "main"),
              ),
            ),
          );
        // A linked repository is the workspace's second. The organisation's
        // first workspace is written without a main repository (ADR-099 §6)
        // and GitHub can be attached to it before the main head exists, and
        // a link then would leave a linked head with no main beside it.
        if (!heads.some((h) => h.role === "main")) {
          throw new HandlerError({
            code: "conflict",
            reason: "main_repo_unbound",
            message:
              "Bind this workspace's main repository first; a linked repository is its second.",
          });
        }
        const same = heads.filter((h) => h.providerRepositoryId === repo.id);
        if (same.some((h) => h.role === "main")) {
          throw new HandlerError({
            code: "conflict",
            reason: "main_repo",
            message: `${repo.fullName} is this workspace's main repository; it is already bound`,
          });
        }
        if (same.length > 0) {
          throw new HandlerError({
            code: "conflict",
            reason: "repository_already_linked",
            message: `${repo.fullName} is already linked to this workspace`,
          });
        }
        return writeRepositoryHead(tx, {
          scope,
          connectionId: connection.id,
          repo,
          role: "linked",
          userId,
          now,
        });
      });
    } catch (err) {
      // The window the pre-check above cannot close: a main claim on this
      // repository that committed elsewhere after the read. The trigger's
      // repository-keyed lock serialised the two writes and refused this one
      // with a constraint name; the sentence is the pre-check's.
      if (repositoryHeadConflict(err) === "main_elsewhere") {
        logger.warn(
          { ...scope, repository: repo.fullName },
          "repository.link: lost the race to a main repository claim elsewhere",
        );
        throw mainRepoClaimed(repo.fullName);
      }
      throw err;
    }

    logger.info(
      {
        ...scope,
        repository: repo.fullName,
        bindingId: written.bindingPublicId,
      },
      "repository.link: repository linked",
    );

    return {
      bindingId: written.bindingPublicId,
      connectionId: connection.publicId,
      fullName: repo.fullName,
      defaultRef: repo.defaultBranch,
      role: "linked",
      linkedAt: now.toISOString(),
    };
  };
}

export const repositoryLinkHandler = createRepositoryLinkHandler(
  githubMainRepositoryDeps,
);
