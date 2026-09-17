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
//      workspace's current binding heads decide idempotent / conflict; else
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

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;
const PROVIDER = "github";

export interface MainRepositoryDeps {
  /** The repository as the installation sees it, or null when it cannot. */
  repository(
    installationId: string,
    owner: string,
    name: string,
  ): Promise<GitHubRepoInfo | null>;
}

/** The workspace's GitHub connection: the installation id the callback attached. */
function installationIdOf(deliveryConfig: unknown): string | null {
  if (typeof deliveryConfig !== "object" || deliveryConfig === null)
    return null;
  const raw = (deliveryConfig as { installationId?: unknown }).installationId;
  if (typeof raw === "string" && /^\d{1,20}$/.test(raw)) return raw;
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0)
    return String(raw);
  return null;
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

    const connection = await withTenantDb(async (tx) => {
      const rows = await tx
        .select({
          id: schema.sourceConnections.id,
          publicId: schema.sourceConnections.publicId,
          status: schema.sourceConnections.status,
          deliveryConfig: schema.sourceConnections.deliveryConfig,
        })
        .from(schema.sourceConnections)
        .where(
          and(
            eq(schema.sourceConnections.orgId, scope.orgId),
            eq(schema.sourceConnections.workspaceId, scope.workspaceId),
            eq(schema.sourceConnections.connectorId, PROVIDER),
            isNull(schema.sourceConnections.deletedAt),
          ),
        );
      for (const row of rows) {
        const installationId = installationIdOf(row.deliveryConfig);
        if (installationId !== null) return { ...row, installationId };
      }
      return null;
    });
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
            publicId: schema.repositoryBindings.publicId,
            createdAt: schema.repositoryBindings.createdAt,
          })
          .from(schema.repositoryBindings)
          .where(eq(schema.repositoryBindings.id, same.currentBindingId))
          .limit(1);
        if (!existing) {
          throw new Error(
            "repository_binding_heads names a binding that does not exist",
          );
        }
        bindingPublicId = existing.publicId;
        boundAt = existing.createdAt;
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
