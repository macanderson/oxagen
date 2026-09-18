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
//   4. One transaction, holding a transaction-scoped advisory lock on the
//      workspace so two binds read the heads one after the other: the
//      workspace's current binding heads decide idempotent / repair (the same
//      repository through a replacement connection, which supersedes the
//      binding onto it) / conflict; else
//      the version-1 binding and its head, the connection marked connected,
//      and the gate's provisional window closed when this workspace is the
//      gate's. No table constraint holds one head per workspace
//      (repository_binding_heads is unique per connection and repository),
//      so the lock is what keeps one main repository.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryMainBind,
  type RepositoryMainBindOutput,
} from "@oxagen/oxagen/contracts/repository.main.bind";
import { schema, withTenantDb } from "@oxagen/database";
import { createGitHubClient, getInstallationToken } from "@oxagen/github";
import type { GitHubRepoInfo } from "@oxagen/github";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  GITHUB_PROVIDER,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;
const PROVIDER = GITHUB_PROVIDER;

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

    const result = await withTenantDb(async (tx) => {
      // A second bind in this workspace waits here until the first commits,
      // then reads the head it wrote.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bind_main_repository:${scope.workspaceId}`}::text, 0))`,
      );
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
          })
          .from(schema.repositoryBindings)
          .where(eq(schema.repositoryBindings.id, same.currentBindingId))
          .limit(1);
        if (!existing) {
          throw new Error(
            "repository_binding_heads names a binding that does not exist",
          );
        }
        if (same.connectionId === connection.id) {
          // Same repository, same connection: nothing has moved, so nothing is
          // written. The first bind's identity is the answer.
          bindingPublicId = existing.publicId;
          boundAt = existing.createdAt;
        } else {
          // Same repository, DIFFERENT connection — the head still points at a
          // connection this workspace no longer acts through. That is the
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
          // for one, unchanged. Only the connection behind the same repository
          // moves here.
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
