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
//      points at — the same rows the bind writes — left-joined to the
//      connection the head names, so the answer says whether that connection
//      is still live (`repository.connectionLive`). A retired connection is
//      the state in which steering silently stops resolving, and reporting the
//      repository without it is what made that state invisible.
//   3. The installation: the workspace's GitHub connection, through the one
//      shared resolver. The installation id is NOT in the output; a caller that
//      could name one could mint tokens for another account's installation.
//   4. The doors to GitHub, which are three and not one: the signed Connect URL
//      (the identity leg, for an account that already carries the App), the
//      signed Install URL (`installations/new`, for an account that does not),
//      and the unsigned manage URL (reconfigure an installation already
//      attached) — or nulls when this deployment cannot complete a connect,
//      which means the whole flow and not merely the redirect.
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
  buildInstallAuthUrl,
  buildManageInstallationUrl,
} from "@oxagen/github";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import {
  isLiveConnectionRow,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";

const MAIN_REPOSITORY_ROLES = ["Owner", "Admin"] as const;

/** The three GitHub doors, or null when the App is not configured here. */
export interface GithubAppUrls {
  /**
   * CONNECT: the signed IDENTITY URL (`login/oauth/authorize`), for an account
   * that already carries the App somewhere. Always returns a `code` and our
   * state; never returns an `installation_id`.
   */
  connectUrl: string;
  /**
   * INSTALL: `installations/new`, SIGNED with the same state. For an account
   * that carries the App nowhere, which is every first-run account.
   */
  installUrl: string;
  /** MANAGE: the App's configuration page for an installation already attached. Unsigned; it starts no flow. */
  manageUrl: string;
}

/**
 * The complete set of env vars a Connect must have to finish its round trip:
 * the two that mint the URLs, the two the public callback demands before it
 * will exchange the `code` GitHub sends back, and the two that mint the
 * installation token every step AFTER the connect runs on. They are
 * independently optional in the env registry, so a deployment can hold some and
 * not others.
 *
 * All six, or no URLs at all. Offering a Connect that the callback answers with
 * 503 strands the operator mid-flow on a GitHub page, with nothing on our side
 * to tell them why; `null` is the contract's honest "unconfigured", which the
 * dialog already renders as "not configured for this deployment".
 *
 * "Finish its round trip" is the whole flow, not the redirect. A deployment
 * holding the OAuth half and not the App's signing half mints a working Connect
 * URL, completes OAuth, and reports the installation attached — and then every
 * `list_installation_repositories` and every `bind_main_repository` throws,
 * because both mint a token with `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`
 * and refuse without them. That strands the operator PAST the point of no
 * return, which is worse than refusing at the door.
 *
 * Exported so `repository.github-env.test.ts` can hold every name in it to the
 * environment contract of every service that invokes this capability. The app
 * runs these handlers in-process (ADR-088), and a var registered for `api`
 * alone reaches no other service's build environment.
 */
export const REQUIRED_GITHUB_APP_ENV = [
  // Mints the identity (connect) URL below.
  "GITHUB_APP_CLIENT_ID",
  // Mints the install and manage URLs below.
  "GITHUB_APP_SLUG",
  // Signs the state both URLs round-trip, and verifies it on the way back.
  "GITHUB_APP_INSTALL_STATE_SECRET",
  // Only the callback needs this one — and without it the callback 503s, so a
  // Connect offered without it cannot complete.
  "GITHUB_APP_CLIENT_SECRET",
  // Neither of these is needed to START the flow, and both are needed for
  // anything the flow is FOR: `getInstallationToken` signs a JWT with them
  // (packages/handlers/src/repository.main.bind.ts,
  // repository.installation.list.ts), and throws
  // "GitHub App is not configured" without them.
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
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
      // "settings" lands the callback back on the Repositories page that sent them.
      connectionId: null,
      returnTo: "settings" as const,
    };
    return {
      // CONNECT: the IDENTITY leg (`login/oauth/authorize`), not
      // `installations/new` — the same rule /connections/github/status follows,
      // for the same reason. `installations/new` only round-trips a `code` on
      // the FIRST install of the App on an account. Once the App is already
      // installed there, GitHub degrades to its stateless setup/update
      // redirect, which carries no code: with only that URL, reconnecting, and
      // connecting a second workspace to an account that already has the App,
      // were both impossible from this dialog. The identity URL always returns
      // code+state, installed or not.
      connectUrl: buildIdentityAuthUrl(clientId, stateSecret, state),
      // INSTALL: `installations/new`, carrying the SAME signed state. The
      // identity leg cannot serve a first-ever install — there is nothing for
      // `/user/installations` to find — and this door used to be minted bare,
      // so GitHub round-tripped no state, the callback took its no-state
      // branch, and the primary first-run path for every new customer ended on
      // the app root with the workspace unconnected and nothing to click
      // (#3254). With the state, the callback knows which workspace asked.
      installUrl: buildInstallAuthUrl(appSlug, stateSecret, state),
      // MANAGE: unsigned on purpose. It starts no flow and carries nothing
      // back — it is where an ALREADY attached installation is reconfigured,
      // never the way to establish one.
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
            // Left-joined, not filtered on: a workspace whose connection has
            // been retired must still be told WHICH repository it binds. See
            // `connectionLive` below.
            connectionStatus: schema.sourceConnections.status,
            connectionDeletedAt: schema.sourceConnections.deletedAt,
          })
          .from(schema.repositoryBindingHeads)
          .innerJoin(
            schema.repositoryBindings,
            eq(
              schema.repositoryBindings.id,
              schema.repositoryBindingHeads.currentBindingId,
            ),
          )
          .leftJoin(
            schema.sourceConnections,
            eq(
              schema.sourceConnections.id,
              schema.repositoryBindingHeads.connectionId,
            ),
          )
          .where(
            and(
              eq(schema.repositoryBindingHeads.orgId, scope.orgId),
              eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
              // Only the MAIN repository steers. `role` is 'main' for every head
              // the binder writes, and 'linked' only for one the exclusivity
              // migration demoted because an older head already claimed the
              // repository. A reader that ignores the column goes on resolving
              // through a demoted head, so the cross-workspace steering collision
              // the index forbids would survive the reconciliation that was meant
              // to end it.
              eq(schema.repositoryBindingHeads.role, "main"),
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
            // The same judgement `readGitHubConnection` makes before it will
            // resolve steering, said out loud. False means the head still
            // points at a connection that is gone or on its way out, so every
            // reader that joins the two finds nothing and steering is off —
            // while this read, which joined only the head to its binding,
            // went on reporting the repository as usable. The workspace looked
            // fine and nothing on any surface could fix it (#3233).
            connectionLive: isLiveConnectionRow({
              status: binding.connectionStatus,
              deletedAt: binding.connectionDeletedAt,
            }),
          }
        : null,
      github: {
        connected: connection !== null,
        connectUrl: urls?.connectUrl ?? null,
        installUrl: urls?.installUrl ?? null,
        manageUrl: urls?.manageUrl ?? null,
      },
    };
  };
}

export const repositoryMainGetHandler =
  createMainRepositoryGetHandler(envGithubUrls);
