// repository.link.ts — `link_repository` (Mission Control spec §10.1; ADR-091).
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
//      workspace's heads decide `main_repo` (it is the main repository here)
//      and `repository_already_linked`; else a binding (reused or superseded
//      when this connection bound the repository before) and a
//      `role = 'linked'` head.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryLink,
  type RepositoryLinkOutput,
} from "@oxagen/oxagen/contracts/repository.link";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq, ne } from "drizzle-orm";
import { logger } from "./logger";
import { writeRepositoryHead } from "./repository.binding-write";
import {
  GITHUB_PROVIDER,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";
import {
  assertGlobalClaimIsKnowable,
  githubMainRepositoryDeps,
  workspaceRepositoriesLock,
  type MainRepositoryDeps,
} from "./repository.main.bind";

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
      // Names neither the organisation nor the workspace holding the claim:
      // the read crosses tenants (see `repositoryClaimedElsewhere`).
      throw new HandlerError({
        code: "conflict",
        reason: "main_repo_claimed",
        message: `${repo.fullName} is the main repository of another workspace. Its .oxagen/ tree governs that workspace, so it cannot be linked here.`,
      });
    }

    const now = new Date();
    const written = await withTenantDb(async (tx) => {
      await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
      const heads = await tx
        .select({
          role: schema.repositoryBindingHeads.role,
          connectionId: schema.repositoryBindingHeads.connectionId,
        })
        .from(schema.repositoryBindingHeads)
        .where(
          and(
            eq(schema.repositoryBindingHeads.orgId, scope.orgId),
            eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
            eq(schema.repositoryBindingHeads.provider, GITHUB_PROVIDER),
            eq(schema.repositoryBindingHeads.providerRepositoryId, repo.id),
          ),
        );
      if (heads.some((h) => h.role === "main")) {
        throw new HandlerError({
          code: "conflict",
          reason: "main_repo",
          message: `${repo.fullName} is this workspace's main repository; it is already bound`,
        });
      }
      if (heads.length > 0) {
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

    logger.info(
      { ...scope, repository: repo.fullName, bindingId: written.bindingPublicId },
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
