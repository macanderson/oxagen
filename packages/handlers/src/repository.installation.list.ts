// repository.installation.list.ts — `list_installation_repositories` (#2967).
//
// The picker behind `bind_main_repository`. It exists so the choice on screen
// and the choice the write accepts are the same set: the bind resolves the
// repository through the installation's token and answers
// `not_found: repository_not_installed` for anything that token cannot read,
// so a picker built from any other list — the user's own repositories, a typed
// `owner/name` — would offer options that refuse on submit.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29), the pair that
//      may bind.
//   2. The installation: the workspace's GitHub connection, through the one
//      shared resolver. The caller names no installation — an installation id
//      a caller could choose would let one tenant enumerate another account's
//      repositories. No installation is `conflict: github_not_connected`, the
//      same refusal the bind gives and the state `get_main_repository` reports.
//   3. The listing, read through the installation's token, sorted by full name
//      so the picker is stable between two reads of an unchanged installation.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryInstallationList,
  type RepositoryInstallationListOutput,
} from "@oxagen/oxagen/contracts/repository.installation.list";
import {
  createGitHubClient,
  getInstallationToken,
  type GitHubInstallationRepositories,
} from "@oxagen/github";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { logger } from "./logger";
import { resolveWorkspaceGithubInstallation } from "./repository.github-connection";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;

export interface InstallationRepositoriesDeps {
  /** What the installation can reach, and whether the walk was bounded short. */
  repositories(installationId: string): Promise<GitHubInstallationRepositories>;
}

export const githubInstallationRepositoriesDeps: InstallationRepositoriesDeps = {
  async repositories(installationId) {
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
    return createGitHubClient({ token }).listInstallationRepositories();
  },
};

export function createInstallationRepositoriesHandler(
  deps: InstallationRepositoriesDeps,
): CapabilityHandler<typeof repositoryInstallationList> {
  return async (_input, ctx): Promise<RepositoryInstallationListOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: [...MAIN_REPOSITORY_ROLES] },
    );
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

    const { repositories, truncated } = await deps.repositories(
      connection.installationId,
    );

    // Sorted by full name so two reads of an unchanged installation put the
    // same repository in the same place; GitHub's own order is not promised.
    const sorted = [...repositories].sort((a, b) =>
      a.fullName.localeCompare(b.fullName),
    );

    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        count: sorted.length,
        truncated,
      },
      "repository.installation.list: installation repositories listed",
    );

    return {
      repositories: sorted.map((r) => ({
        id: r.id,
        owner: r.owner,
        name: r.name,
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        private: r.private,
        htmlUrl: r.htmlUrl,
      })),
      truncated,
    };
  };
}

export const repositoryInstallationListHandler =
  createInstallationRepositoriesHandler(githubInstallationRepositoriesDeps);
