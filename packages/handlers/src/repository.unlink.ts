// repository.unlink.ts: `unlink_repository` (ADR-212).
//
// Flow:
//   1. Role gate: assertOrgRole, org Owner or Admin, or the workspace's Owner
//      (INV-29).
//   2. The head whose current binding carries this `rpb_…` id in THIS
//      workspace. RLS and the explicit org and workspace predicates both bound
//      the read. None is `not_found: repository_not_linked`. A steering head
//      is `conflict: main_repo_unlink_refused`, because a workspace without a
//      steering repository cannot exist.
//   3. workspace.toml on the steering repository's production branch decides
//      the path:
//      - it lists the repository: a steering PR removes the entry, from
//        `workspace/unlink-<owner>-<name>-<hash>`. The head stays until that
//        PR merges and the steering sync reads the new file.
//        `status: proposed`.
//      - it does not list it, is missing, or names another schema: the link
//        predates the steering record, so nothing there would remove it. The
//        head is deleted now, under the workspace's repository lock.
//        `status: unlinked`.
//      - it names workspace/v1 and does not read against it:
//        `conflict: workspace_toml_unreadable`. The handler cannot tell which
//        path applies.
//
// Only the head goes. It is a pointer, not evidence. The binding versions it
// pointed at stay, because admitted runs cite them. Linking the repository
// again writes the next version through `writeRepositoryHead`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryUnlink,
  type RepositoryUnlinkOutput,
} from "@oxagen/oxagen/contracts/repository.unlink";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { createSteeringHost } from "./context.steering.host";
import { postgresSteeringStore } from "./context.steering.store";
import {
  authorOf,
  type SteeringPrProposalStore,
} from "./steering-repo/pr-proposal";
import { logger } from "./logger";
import { GITHUB_PROVIDER } from "./repository.github-connection";
import {
  readSteeringWorkspaceToml,
  type RepositorySteeringHost,
  workspaceTomlUnreadable,
} from "./repository.link";
import { workspaceRepositoriesLock } from "./repository.binding-write";
import {
  openSteeringPullRequest,
  workspaceTomlBranch,
} from "./repository.steering-pr";
import { githubRepoRef, withoutRepository } from "./repository.workspace-toml";

type Scope = { orgId: string; workspaceId: string };

export interface RepositoryUnlinkDeps {
  steering: RepositorySteeringHost;
  /** Where the workspace.toml PR's proposal row is written (#5122). */
  proposals?: SteeringPrProposalStore;
}

/**
 * The workspace.toml ref of a GitHub repository, or null for a name no ref
 * can spell. workspace.toml cannot list such a head, so the unlink deletes it
 * directly instead of throwing an internal error.
 */
function refOf(owner: string, name: string): string | null {
  try {
    return githubRepoRef(owner, name);
  } catch {
    return null;
  }
}

function notLinked(bindingId: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "repository_not_linked",
    message: `No repository with binding ${bindingId} is linked to this workspace`,
  });
}

/** The head that `bindingId` names in this workspace, or null. */
async function readHead(
  tx: Tx,
  scope: Scope,
  bindingId: string,
) {
  const [head] = await tx
    .select({
      id: schema.repositoryBindingHeads.id,
      role: schema.repositoryBindingHeads.role,
      provider: schema.repositoryBindingHeads.provider,
      owner: schema.repositoryBindings.providerOwner,
      name: schema.repositoryBindings.providerName,
      fullName: schema.repositoryBindings.providerFullName,
    })
    .from(schema.repositoryBindingHeads)
    .innerJoin(
      schema.repositoryBindings,
      eq(
        schema.repositoryBindings.id,
        schema.repositoryBindingHeads.currentBindingId,
      ),
    )
    .where(
      and(
        eq(schema.repositoryBindingHeads.orgId, scope.orgId),
        eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
        eq(schema.repositoryBindings.publicId, bindingId),
      ),
    )
    .limit(1);
  return head ?? null;
}

export function createRepositoryUnlinkHandler(
  deps: RepositoryUnlinkDeps,
): CapabilityHandler<typeof repositoryUnlink> {
  return async (input, ctx): Promise<RepositoryUnlinkOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const head = await withTenantDb((tx) =>
      readHead(tx, scope, input.bindingId),
    );
    if (!head) throw notLinked(input.bindingId);
    if (schema.isSteeringHeadRole(head.role)) {
      throw new HandlerError({
        code: "conflict",
        reason: "main_repo_unlink_refused",
        message: `${head.fullName} is this workspace's steering repository and cannot be unlinked. A workspace always has one steering repository.`,
      });
    }

    const { repo, file } = await readSteeringWorkspaceToml(
      deps.steering,
      scope,
    );
    if (file.kind === "unreadable") {
      throw workspaceTomlUnreadable(
        repo,
        `does not read as workspace/v1 (${file.issues.map((i) => i.message).join("; ")})`,
      );
    }
    // `link_repository` writes only GitHub repositories, so workspace.toml
    // names a linked head by its github.com ref.
    const ref =
      head.provider === GITHUB_PROVIDER ? refOf(head.owner, head.name) : null;

    if (file.kind === "read" && ref !== null && file.repositories.includes(ref)) {
      const pullRequest = await openSteeringPullRequest(
        deps.steering,
        repo,
        {
          branch: workspaceTomlBranch("unlink", head.owner, head.name),
          content: withoutRepository(file, ref),
          message: `Unlink ${head.fullName} from the workspace`,
          title: `Unlink ${head.fullName}`,
          body: [
            `This steering PR removes \`${ref}\` from \`${WORKSPACE_TOML_PATH}\`.`,
            "",
            `When it merges, the steering sync unlinks ${head.fullName} from the workspace. Until then the repository stays linked.`,
          ].join("\n"),
        },
        // The PR's workspace proposal row, so Oxagen can merge it (#5122).
        deps.proposals === undefined
          ? undefined
          : {
              store: deps.proposals,
              scope,
              author: authorOf(ctx, actingUserId),
              now: new Date(),
            },
      );
      logger.info(
        {
          ...scope,
          repository: head.fullName,
          bindingId: input.bindingId,
          pr: pullRequest.url,
          reused: pullRequest.reused,
        },
        "repository.unlink: opened the steering PR",
      );
      return {
        bindingId: input.bindingId,
        fullName: head.fullName,
        status: "proposed",
        unlinkedAt: null,
        steeringPullRequest: pullRequest,
      };
    }

    // No entry to remove. Delete under the lock, and read the head again
    // there: a concurrent unlink or a sync may have removed it since.
    const fullName = await withTenantDb(async (tx) => {
      await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
      const locked = await readHead(tx, scope, input.bindingId);
      if (!locked || locked.id !== head.id) throw notLinked(input.bindingId);
      await tx
        .delete(schema.repositoryBindingHeads)
        .where(eq(schema.repositoryBindingHeads.id, locked.id));
      return locked.fullName;
    });

    logger.info(
      { ...scope, repository: fullName, bindingId: input.bindingId },
      "repository.unlink: workspace.toml does not list the repository, so the head was deleted",
    );
    return {
      bindingId: input.bindingId,
      fullName,
      status: "unlinked",
      unlinkedAt: new Date().toISOString(),
      steeringPullRequest: null,
    };
  };
}

export const repositoryUnlinkHandler = createRepositoryUnlinkHandler({
  steering: createSteeringHost(),
  proposals: postgresSteeringStore,
});
