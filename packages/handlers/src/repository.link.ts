// repository.link.ts: `link_repository` (ADR-212).
//
// The steering record decides which code repositories a workspace links.
// This handler writes no head. It opens a steering PR that adds the
// repository to workspace.toml, and the steering sync writes the head once
// that PR merges.
//
// Flow:
//   1. Role gate: assertOrgRole, org Owner or Admin, or the workspace's Owner
//      (INV-29).
//   2. The checks the sync applies when it writes the head
//      (`repository.link.write.ts`): the installation, the repository, another
//      workspace's steering claim, and this workspace's heads. A steering PR
//      that could never take effect is refused before it is opened.
//   3. workspace.toml on the steering repository's production branch:
//      - it lists the repository already: `status: listed`, no PR. The next
//        steering sync writes the head.
//      - it is missing: the steering PR creates it with this one entry.
//      - it reads as workspace/v1: the steering PR appends the entry.
//      - it names another schema, or names workspace/v1 and does not read
//        against it: `conflict: workspace_toml_unreadable`. The handler
//        will not overwrite a file it cannot read.
//   4. The steering PR, from `workspace/link-<owner>-<name>-<hash>`. A second
//      call for the same repository reuses the branch and the open PR.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryLink,
  type RepositoryLinkOutput,
} from "@oxagen/oxagen/contracts/repository.link";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import {
  githubRefused,
  type SteeringHost,
  type SteeringRepository,
} from "./context.steering.github";
import { createSteeringHost } from "./context.steering.host";
import { logger } from "./logger";
import { assertLinkAllowed, resolveLinkTarget } from "./repository.link.write";
import {
  githubMainRepositoryDeps,
  type MainRepositoryDeps,
} from "./repository.main.bind";
import {
  openSteeringPullRequest,
  type SteeringPullRequestHost,
  workspaceTomlBranch,
} from "./repository.steering-pr";
import {
  githubRepoRef,
  newWorkspaceToml,
  readWorkspaceToml,
  withRepository,
} from "./repository.workspace-toml";

type Scope = { orgId: string; workspaceId: string };

/** The steering host calls `link_repository` and `unlink_repository` make. */
export type RepositorySteeringHost = Pick<
  SteeringHost,
  "resolveRepository" | "readFile"
> &
  SteeringPullRequestHost;

export interface RepositoryLinkDeps {
  repository: MainRepositoryDeps["repository"];
  steering: RepositorySteeringHost;
  /** The organization and workspace slugs a new workspace.toml names. */
  workspaceNames(
    scope: Scope,
  ): Promise<{ organization: string; workspace: string } | null>;
}

/** The slugs of the caller's organization and workspace. */
export async function readWorkspaceNames(
  scope: Scope,
): Promise<{ organization: string; workspace: string } | null> {
  return withTenantDb(async (tx) => {
    const [org] = await tx
      .select({ slug: schema.organizations.slug })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, scope.orgId))
      .limit(1);
    const [workspace] = await tx
      .select({ slug: schema.workspaces.slug })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, scope.workspaceId),
          eq(schema.workspaces.orgId, scope.orgId),
        ),
      )
      .limit(1);
    return org && workspace
      ? { organization: org.slug, workspace: workspace.slug }
      : null;
  });
}

/** workspace.toml on the production branch of the steering repository. */
export async function readSteeringWorkspaceToml(
  steering: Pick<SteeringHost, "resolveRepository" | "readFile">,
  scope: Scope,
): Promise<{
  repo: SteeringRepository;
  file: ReturnType<typeof readWorkspaceToml>;
}> {
  try {
    const repo = await steering.resolveRepository(scope);
    const text = await steering.readFile(
      repo,
      WORKSPACE_TOML_PATH,
      repo.defaultBranch,
    );
    return { repo, file: readWorkspaceToml(text) };
  } catch (err) {
    throw githubRefused(err);
  }
}

/** The refusal for a workspace.toml the handlers will not edit. */
export function workspaceTomlUnreadable(
  repo: SteeringRepository,
  detail: string,
): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "workspace_toml_unreadable",
    message: `${WORKSPACE_TOML_PATH} on ${repo.fullName}@${repo.defaultBranch} ${detail}. Fix the file on the production branch, then try again.`,
  });
}

export function createRepositoryLinkHandler(
  deps: RepositoryLinkDeps,
): CapabilityHandler<typeof repositoryLink> {
  return async (input, ctx): Promise<RepositoryLinkOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const target = await resolveLinkTarget(
      scope,
      input.owner,
      input.name,
      deps,
    );
    await withTenantDb((tx) => assertLinkAllowed(tx, scope, target.repo));

    const { repo, file } = await readSteeringWorkspaceToml(
      deps.steering,
      scope,
    );
    const ref = githubRepoRef(target.repo.owner, target.repo.name);
    const answer = (
      status: RepositoryLinkOutput["status"],
      steeringPullRequest: RepositoryLinkOutput["steeringPullRequest"],
    ): RepositoryLinkOutput => ({
      fullName: target.repo.fullName,
      defaultRef: target.repo.defaultBranch,
      status,
      steeringPullRequest,
    });

    let content: string;
    switch (file.kind) {
      case "foreign":
        throw workspaceTomlUnreadable(
          repo,
          "does not name the workspace/v1 schema on its first line",
        );
      case "unreadable":
        throw workspaceTomlUnreadable(
          repo,
          `does not read as workspace/v1 (${file.issues.map((i) => i.message).join("; ")})`,
        );
      case "read":
        if (file.repositories.includes(ref)) {
          logger.info(
            { ...scope, repository: target.repo.fullName },
            "repository.link: workspace.toml already lists the repository",
          );
          return answer("listed", null);
        }
        content = withRepository(file, ref);
        break;
      case "missing": {
        const names = await deps.workspaceNames(scope);
        if (!names) {
          throw new HandlerError({
            code: "not_found",
            reason: "workspace_not_found",
            message: "This workspace or its organization no longer exists",
          });
        }
        content = newWorkspaceToml(names.organization, names.workspace, ref);
        break;
      }
    }

    const pullRequest = await openSteeringPullRequest(deps.steering, repo, {
      branch: workspaceTomlBranch("link", target.repo.owner, target.repo.name),
      content,
      message: `Link ${target.repo.fullName} to the workspace`,
      title: `Link ${target.repo.fullName}`,
      body: [
        `This steering PR adds \`${ref}\` to \`${WORKSPACE_TOML_PATH}\`.`,
        "",
        `When it merges, the steering sync links ${target.repo.fullName} to the workspace. Until then the repository is not linked.`,
      ].join("\n"),
    });

    logger.info(
      {
        ...scope,
        repository: target.repo.fullName,
        pr: pullRequest.url,
        reused: pullRequest.reused,
      },
      "repository.link: opened the steering PR",
    );
    return answer("proposed", pullRequest);
  };
}

export const repositoryLinkHandler = createRepositoryLinkHandler({
  repository: githubMainRepositoryDeps.repository,
  steering: createSteeringHost(),
  workspaceNames: readWorkspaceNames,
});
