// repository.main.get.ts — `get_main_repository` (#2967).
//
// The read behind the Workspace settings dialog's Repository section, and the
// read that unblocks it. `bind_main_repository` refuses
// `conflict: github_not_connected` unless the workspace already carries a
// GitHub App installation, and nothing in the app could produce one: the
// install leg is an HTTP flow the API runs, and no capability handed out its
// signed URL. This answers all three faces of "can this workspace keep its
// steering in git yet, and if not, what is the next click".
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin (INV-29), the pair the
//      bind admits, because the install URL here is the first half of that write.
//   2. The binding: the workspace's binding head and the binding version it
//      points at — the same rows the bind writes.
//   3. The installation: the workspace's GitHub connection, through the one
//      shared resolver. The installation id is NOT in the output; a caller that
//      could name one could mint tokens for another account's installation.
//   4. The doors to GitHub: the signed install URL and the manage URL, or nulls
//      when this deployment has no GitHub App configured.
//
// This handler makes no GitHub API call. It is a settings read that has to
// render while GitHub is down, and every fact it reports is already local.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  repositoryMainGet,
  type RepositoryMainGetOutput,
} from "@oxagen/oxagen/contracts/repository.main.get";
import { schema, withTenantDb } from "@oxagen/database";
import {
  buildInstallAuthUrl,
  buildManageInstallationUrl,
} from "@oxagen/github";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { resolveWorkspaceGithubInstallation } from "./repository.github-connection";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;

/** The two GitHub doors, or null when the App is not configured here. */
export interface GithubAppUrls {
  installUrl: string;
  manageUrl: string;
}

export interface MainRepositoryGetDeps {
  /**
   * The signed install URL for this org+workspace and the App's manage URL, or
   * null when the deployment has no GitHub App (`GITHUB_APP_SLUG` /
   * `GITHUB_APP_INSTALL_STATE_SECRET` unset).
   *
   * Null rather than a throw on purpose: the contract makes both URLs
   * nullable, and a deployment without the App configured must still render
   * the dialog — the repository it already binds is worth showing even when
   * nobody can install anything.
   */
  githubUrls(payload: {
    orgId: string;
    workspaceId: string;
  }): GithubAppUrls | null;
}

const envGithubUrls: MainRepositoryGetDeps = {
  githubUrls({ orgId, workspaceId }) {
    const appSlug = process.env["GITHUB_APP_SLUG"];
    const stateSecret = process.env["GITHUB_APP_INSTALL_STATE_SECRET"];
    if (!appSlug || !stateSecret) return null;
    return {
      // connectionId null: this is the settings-level connect (1 workspace =
      // 1 app install), which creates no source_connection up front. returnTo
      // "settings" lands the callback back on the dialog that sent them.
      installUrl: buildInstallAuthUrl(appSlug, stateSecret, {
        orgId,
        workspaceId,
        connectionId: null,
        returnTo: "settings",
      }),
      manageUrl: buildManageInstallationUrl(appSlug),
    };
  },
};

export function createMainRepositoryGetHandler(
  deps: MainRepositoryGetDeps,
): CapabilityHandler<typeof repositoryMainGet> {
  return async (_input, ctx): Promise<RepositoryMainGetOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: [...MAIN_REPOSITORY_ROLES] },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const [binding, connection] = await Promise.all([
      withTenantDb(async (tx) => {
        const rows = await tx
          .select({
            bindingId: schema.repositoryBindings.publicId,
            owner: schema.repositoryBindings.providerOwner,
            name: schema.repositoryBindings.providerName,
            fullName: schema.repositoryBindings.providerFullName,
            defaultRef: schema.repositoryBindings.configuredDefaultRef,
            boundAt: schema.repositoryBindings.createdAt,
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
            ),
          )
          .limit(1);
        return rows[0] ?? null;
      }),
      resolveWorkspaceGithubInstallation(scope),
    ]);

    const urls = deps.githubUrls(scope);

    return {
      repository: binding
        ? {
            bindingId: binding.bindingId,
            owner: binding.owner,
            name: binding.name,
            fullName: binding.fullName,
            defaultRef: binding.defaultRef,
            // The bind persists no html url — the provider's canonical one is
            // derived from the full name it does persist, so a rename that
            // has not been re-observed still links somewhere GitHub redirects.
            htmlUrl: `https://github.com/${binding.fullName}`,
            boundAt: binding.boundAt.toISOString(),
          }
        : null,
      github: {
        connected: connection !== null,
        installUrl: urls?.installUrl ?? null,
        manageUrl: urls?.manageUrl ?? null,
      },
    };
  };
}

export const repositoryMainGetHandler =
  createMainRepositoryGetHandler(envGithubUrls);
