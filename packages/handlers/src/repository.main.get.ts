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
//   4. The doors to GitHub: the signed Connect URL (the identity leg, which
//      works whether or not the App is already installed on the target
//      account) and the manage URL, or nulls when this deployment cannot
//      complete a connect.
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
  buildIdentityAuthUrl,
  buildManageInstallationUrl,
} from "@oxagen/github";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { resolveWorkspaceGithubInstallation } from "./repository.github-connection";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;

/** The two GitHub doors, or null when the App is not configured here. */
export interface GithubAppUrls {
  /**
   * The dialog's Connect action: the signed IDENTITY URL
   * (`login/oauth/authorize`), not `installations/new`. Named `installUrl`
   * because that is the contract's field; what it opens is the authorization
   * leg. See `envGithubUrls` for why.
   */
  installUrl: string;
  manageUrl: string;
}

/**
 * The complete set of env vars a Connect must have to finish its round trip:
 * the two that mint the URL, and the two the public callback demands before it
 * will exchange the `code` GitHub sends back. They are independently optional
 * in the env registry, so a deployment can hold some and not others.
 *
 * All four, or no URLs at all. Offering a Connect that the callback answers
 * with 503 strands the operator mid-flow on a GitHub page, with nothing on our
 * side to tell them why; `null` is the contract's honest "unconfigured", which
 * the dialog already renders as "not configured for this deployment".
 */
const REQUIRED_GITHUB_APP_ENV = [
  // Mints the identity URL below.
  "GITHUB_APP_CLIENT_ID",
  // Mints the manage URL below.
  "GITHUB_APP_SLUG",
  // Signs the state both URLs round-trip, and verifies it on the way back.
  "GITHUB_APP_INSTALL_STATE_SECRET",
  // Only the callback needs this one — and without it the callback 503s, so a
  // Connect offered without it cannot complete.
  "GITHUB_APP_CLIENT_SECRET",
] as const;

export interface MainRepositoryGetDeps {
  /**
   * The signed Connect URL for this org+workspace and the App's manage URL, or
   * null when this deployment cannot complete a GitHub connect (any of
   * {@link REQUIRED_GITHUB_APP_ENV} unset).
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

/**
 * The production `githubUrls`, reading the deployment's GitHub App env.
 * Exported for its own tests: which URL the Connect action opens, and the
 * complete env set it takes to offer one, are both behaviour worth pinning.
 */
export const envGithubUrls: MainRepositoryGetDeps = {
  githubUrls({ orgId, workspaceId }) {
    // Every var in the set, or nothing: a partially configured deployment
    // cannot finish the round trip, so it offers no door.
    if (REQUIRED_GITHUB_APP_ENV.some((name) => !process.env[name])) return null;
    const clientId = process.env["GITHUB_APP_CLIENT_ID"] ?? "";
    const appSlug = process.env["GITHUB_APP_SLUG"] ?? "";
    const stateSecret = process.env["GITHUB_APP_INSTALL_STATE_SECRET"] ?? "";
    const state = {
      orgId,
      workspaceId,
      // connectionId null: this is the settings-level connect (1 workspace =
      // 1 app install), which creates no source_connection up front. returnTo
      // "settings" lands the callback back on the dialog that sent them.
      connectionId: null,
      returnTo: "settings" as const,
    };
    return {
      // The IDENTITY leg (`login/oauth/authorize`), not `installations/new` —
      // the same rule /connections/github/status follows, for the same reason.
      // `installations/new` only round-trips a `code` and our signed `state` on
      // the FIRST install of the App on an account. Once the App is already
      // installed there, GitHub degrades to its stateless setup/update
      // redirect, which carries neither: the callback takes its no-state
      // branch, redirects to the app root and attaches nothing. So with the
      // install URL here, reconnecting, and connecting a second workspace to an
      // account that already has the App, were both impossible from this
      // dialog. The identity URL always returns code+state, installed or not.
      installUrl: buildIdentityAuthUrl(clientId, stateSecret, state),
      // The other door, unchanged: change which repositories the existing
      // installation reaches (and the way to install it on a further account).
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
