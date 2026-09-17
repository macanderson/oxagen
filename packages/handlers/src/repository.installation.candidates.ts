// repository.installation.candidates.ts — `list_github_installations`.
//
// The other half of the connect. The Workspace settings dialog opens GitHub's
// IDENTITY url, which always returns a `code` and never an `installation_id`,
// so a person whose account already carries the App comes back holding a live
// token with nothing attached. The callback settles that itself when the
// answer is unambiguous — exactly one reachable installation is attached
// there and then — and this read exists for the case it cannot settle: a
// person who administers two accounts that both carry the App has to say which
// one this workspace acts through.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29), the pair that
//      may attach and bind.
//   2. The candidates: `GET /user/installations` for the org's stored GitHub
//      authorization. No token to ask with is `conflict: github_not_authorized`
//      — connect GitHub first, which is a different next click from "install
//      the App", and an empty list is the second of those, not a refusal.
//   3. Sorted by account login, so two reads of an unchanged account put the
//      same row in the same place; GitHub's order is not promised.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryInstallationCandidates,
  type RepositoryInstallationCandidatesOutput,
} from "@oxagen/oxagen/contracts/repository.installation.candidates";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { logger } from "./logger";
import {
  githubUserInstallationsDeps,
  type GithubUserInstallationsDeps,
} from "./repository.github-user-installations";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;

export function createInstallationCandidatesHandler(
  deps: GithubUserInstallationsDeps,
): CapabilityHandler<typeof repositoryInstallationCandidates> {
  return async (
    _input,
    ctx,
  ): Promise<RepositoryInstallationCandidatesOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: [...MAIN_REPOSITORY_ROLES] },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const candidates = await deps.candidates(scope);
    if (candidates === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "github_not_authorized",
        message:
          "This workspace has no usable GitHub authorization to list installations with; connect GitHub first",
      });
    }

    // An installation GitHub reported without an account is one this picker
    // could not name, and naming what it offers is the whole job. It stays
    // reachable — `attach_github_installation` matches against the unfiltered
    // list — it is simply not offered as a choice nobody could read.
    const named = candidates.filter(
      (
        installation,
      ): installation is typeof installation & { accountLogin: string } =>
        installation.accountLogin !== null,
    );

    const sorted = [...named].sort((a, b) =>
      a.accountLogin.localeCompare(b.accountLogin),
    );

    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        count: sorted.length,
      },
      "repository.installation.candidates: reachable installations listed",
    );

    return {
      installations: sorted.map((installation) => ({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        avatarUrl: installation.avatarUrl,
        repositorySelection: installation.repositorySelection,
      })),
    };
  };
}

export const repositoryInstallationCandidatesHandler =
  createInstallationCandidatesHandler(githubUserInstallationsDeps);
