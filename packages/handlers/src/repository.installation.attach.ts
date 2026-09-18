// repository.installation.attach.ts — `attach_github_installation`.
//
// The write behind `list_github_installations`: a person who administers
// several accounts that all carry the App says which of them this workspace
// reaches repositories through.
//
// The id arrives from a caller, which is why it is checked rather than
// trusted. `bind_main_repository` and `list_installation_repositories` both
// mint a token with the platform App's PRIVATE KEY against whatever
// installation the workspace's connection names, and that token carries no
// caller entitlement — GitHub asks who the App is, not who asked. So an
// unverified id here is another account's source code, listed and bindable.
// It is matched against `GET /user/installations` answered for this
// workspace's own stored authorization before a single row is written, which
// is the same rule the HMAC-verified install callback applies to the
// `installation_id` GitHub redirects with.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29).
//   2. The candidates, from the workspace's stored GitHub authorization. No
//      token is `conflict: github_not_authorized`.
//   3. The match. Absent from that list → `not_found: installation_unreachable`,
//      whatever else is true of the id. Fail closed: a false refusal costs a
//      click, a false acceptance costs another tenant's repositories.
//   4. The attach, onto the same connection row every repository read resolves.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryInstallationAttach,
  type RepositoryInstallationAttachOutput,
} from "@oxagen/oxagen/contracts/repository.installation.attach";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { logger } from "./logger";
import { attachWorkspaceGithubInstallation } from "./repository.github-connection";
import {
  githubUserInstallationsDeps,
  type GithubUserInstallationsDeps,
} from "./repository.github-user-installations";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;

export function createInstallationAttachHandler(
  deps: GithubUserInstallationsDeps,
): CapabilityHandler<typeof repositoryInstallationAttach> {
  return async (input, ctx): Promise<RepositoryInstallationAttachOutput> => {
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
          "This workspace has no usable GitHub authorization to verify an installation with; connect GitHub first",
      });
    }

    const chosen = candidates.find(
      (installation) => installation.installationId === input.installationId,
    );
    if (chosen === undefined) {
      logger.warn(
        {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          installationId: input.installationId,
        },
        "repository.installation.attach: the caller cannot reach this installation — nothing attached",
      );
      throw new HandlerError({
        code: "not_found",
        reason: "installation_unreachable",
        message:
          "The connected GitHub account cannot reach that installation; pick one it can, or install the App on that account",
      });
    }

    const { publicId } = await attachWorkspaceGithubInstallation({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      installationId: chosen.installationId,
      actingUserId,
    });

    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        connectionId: publicId,
        installationId: chosen.installationId,
      },
      "repository.installation.attach: installation attached to the workspace",
    );

    return { connectionId: publicId, accountLogin: chosen.accountLogin };
  };
}

export const repositoryInstallationAttachHandler =
  createInstallationAttachHandler(githubUserInstallationsDeps);
