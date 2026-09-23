// `create_workspace`: a workspace in the caller's org, with its main repository
// (Mission Control spec §10.1, §17 M0; ADR-099).
//
//   1. Role gate — assertOrgRole: org Owner or Admin, or the Owner of the
//      workspace the call is scoped to (the contract's defaultRoles; INV-29),
//      for the signed-in user or the creator of the API key
//      (resolveActingUserId). The gate refuses a call with no acting user,
//      so the bootstrap below always has a creator.
//   2. The slug is unique in the org: the pre-check and the unique index's
//      23505 both read as `conflict` / `slug_taken`.
//   3. The installation. The workspace does not exist yet, so it has no GitHub
//      connection to take one from. The org's stored GitHub authorization does
//      exist — `ingestion.oauth_accounts` is keyed by org — so the installation
//      is the one `GET /user/installations` answers for that authorization on
//      the repository's owner account: the reachability rule
//      `attach_github_installation` applies, never an id from the caller.
//   4. The repository, read through that installation's token.
//   5. The global main-repository claim: refused when another workspace
//      already steers by it (`main_repo_claimed`) or has linked it
//      (`repository_linked_elsewhere`), before anything is written.
//   6. ONE transaction: the workspace bootstrap, its GitHub connection (the
//      installation attached, `connected`), the version-1 binding and its
//      `role = 'main'` head. Any failure — including losing the race for the
//      claim to the store's rule, the index
//      `repository_binding_heads_main_repository_uq` or the trigger
//      `repository_binding_heads_exclusive_main` — rolls back the workspace
//      with it. A workspace without a main repo is never written.
//
// Steps 3–5 call GitHub, so they run before the transaction and fail closed:
// a refusal there writes nothing.
//
// A GitLab main project (#3762) replaces steps 3–4: the request carries a
// project access token, verified as `attach_gitlab_project` verifies it, and
// the transaction writes a GitLab connection holding that token encrypted
// instead of a GitHub one. No GitHub authorization is read. The project
// webhook is registered last inside the transaction, once the connection id
// it names exists.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  workspaceCreate,
  type WorkspaceCreateOutput,
} from "@oxagen/oxagen/contracts/workspace.create";
import {
  schema,
  withTenantDb,
  isUniqueViolation,
  type Tx,
} from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { GitLabApiError, parseGitLabProjectPath } from "@oxagen/gitlab";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  writeRepositoryHead,
  type BindableRepository,
  type RepositoryProvider,
} from "./repository.binding-write";
import { GITLAB_AUTH_SCHEME, GITLAB_PROVIDER } from "./lib/gitlab-credential";
import type { GitLabDeliveryConfig } from "./repository.gitlab-connection";
import {
  gitlabAttachDeps,
  verifyProjectToken,
  type GitLabAttachDeps,
} from "./repository.gitlab.attach";
import {
  GITHUB_PROVIDER,
  orgGithubOauthAccountId,
} from "./repository.github-connection";
import {
  githubUserInstallationsDeps,
  type GithubUserInstallationsDeps,
} from "./repository.github-user-installations";
import {
  assertGlobalClaimIsKnowable,
  assertNotHeldElsewhere,
  assertPlaneStillShared,
  githubMainRepositoryDeps,
  headsHeldElsewhere,
  repositoryHeadConflict,
  rethrowHeadConflict,
  type MainRepositoryDeps,
} from "./repository.main.bind";
import { bootstrapWorkspace } from "./workspace-bootstrap";

const slugTaken = (slug: string) =>
  new HandlerError({
    code: "conflict",
    reason: "slug_taken",
    message: `A workspace with the slug ${slug} already exists in this organization`,
  });

export type WorkspaceCreateDeps = GithubUserInstallationsDeps &
  MainRepositoryDeps & {
    /** GitLab client, sealing and webhook URL; defaults to the attach flow's. */
    gitlab?: GitLabAttachDeps;
  };

/**
 * What a creation binds: the repository as its host reported it, and the
 * writer of the new workspace's connection to that host, run inside the
 * creation's transaction.
 */
interface CreationTarget {
  provider: RepositoryProvider;
  repo: BindableRepository;
  writeConnection(
    tx: Tx,
    args: { orgId: string; workspaceId: string; userId: string; now: Date },
  ): Promise<{ id: string; publicId: string }>;
}

/**
 * The GitLab arm: verify the token for the project, seal it with a fresh
 * webhook secret, and write the connection and its credential. The hook is
 * registered after both rows exist; a token whose role cannot manage hooks
 * still creates the workspace, and `attach_gitlab_project` registers the hook
 * later.
 */
async function gitlabCreationTarget(
  deps: GitLabAttachDeps,
  input: { projectPath: string; token: string },
  surface: string,
): Promise<CreationTarget> {
  if (surface !== "api")
    throw new HandlerError({
      code: "conflict",
      reason: "gitlab_token_surface",
      message:
        "A GitLab project access token is accepted from the web app or the API only, never through an agent or MCP transcript.",
    });
  const path = parseGitLabProjectPath(input.projectPath);
  if (!path)
    throw new HandlerError({
      code: "conflict",
      reason: "invalid_project_path",
      message: `${input.projectPath} is not a gitlab.com project path. Use group/project, or group/subgroup/project.`,
    });
  const gl = deps.client(input.token);
  const { project } = await verifyProjectToken(gl, path.fullPath);
  const webhookSecret = deps.newSecret();
  const sealed = await deps.seal(
    JSON.stringify({ token: input.token, webhookSecret }),
  );
  return {
    provider: GITLAB_PROVIDER,
    repo: {
      id: project.id,
      owner: project.namespaceFullPath,
      name: project.path,
      fullName: project.pathWithNamespace,
      // verifyProjectToken refused a project without one.
      defaultBranch: project.defaultBranch as string,
    },
    async writeConnection(tx, { orgId, workspaceId, userId, now }) {
      const config: GitLabDeliveryConfig = {
        projectId: project.id,
        projectPath: project.pathWithNamespace,
        webhookId: null,
      };
      const [connection] = await tx
        .insert(schema.sourceConnections)
        .values({
          orgId,
          workspaceId,
          connectorId: GITLAB_PROVIDER,
          displayName: `GitLab · ${project.pathWithNamespace}`,
          authScheme: GITLAB_AUTH_SCHEME,
          deliveryMethod: "webhook",
          deliveryConfig: config,
          status: "connected",
          createdAt: now,
          updatedAt: now,
          createdById: userId,
        })
        .returning({
          id: schema.sourceConnections.id,
          publicId: schema.sourceConnections.publicId,
        });
      if (!connection)
        throw new Error("source_connections insert returned no row");
      await tx.insert(schema.authCredentials).values({
        connectionId: connection.id,
        authScheme: GITLAB_AUTH_SCHEME,
        encryptedPayload: sealed,
      });
      try {
        const hook = await gl.createProjectHook({
          project: project.id,
          url: deps.webhookUrl(connection.publicId),
          token: webhookSecret,
          mergeRequestsEvents: true,
          pushEvents: false,
        });
        await tx
          .update(schema.sourceConnections)
          .set({ deliveryConfig: { ...config, webhookId: hook.id } })
          .where(eq(schema.sourceConnections.id, connection.id));
      } catch (err) {
        if (!(err instanceof GitLabApiError && err.status === 403)) throw err;
      }
      return connection;
    },
  };
}

/**
 * The GitHub arm: the installation the org's own GitHub authorization reaches
 * on the repository's owner, and the repository read through it.
 */
async function githubCreationTarget(
  deps: WorkspaceCreateDeps,
  ctx: { orgId: string; workspaceId: string },
  mainRepo: { owner: string; name: string },
): Promise<CreationTarget> {
  const { owner, name } = mainRepo;
  // ── The installation, from the org's own GitHub authorization ──────────
  const candidates = await deps.candidates({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  });
  if (candidates === null) {
    throw new HandlerError({
      code: "conflict",
      reason: "github_not_authorized",
      message:
        "This organization has no usable GitHub authorization to reach a repository with; connect GitHub from an existing workspace's settings first",
    });
  }
  // One App installation per account, and a repository's owner IS the
  // account it is installed on, so the owner picks the installation. GitHub
  // logins are case-insensitive.
  const installation = candidates.find(
    (c) => c.accountLogin?.toLowerCase() === owner.toLowerCase(),
  );
  if (!installation) {
    throw new HandlerError({
      code: "not_found",
      reason: "installation_unreachable",
      message: `The GitHub App is not installed on ${owner}, or the organization's GitHub account cannot reach that installation`,
    });
  }

  const repo = await deps.repository(installation.installationId, owner, name);
  if (!repo) {
    throw new HandlerError({
      code: "not_found",
      reason: "repository_not_installed",
      message: `The GitHub App installation on ${owner} cannot see ${owner}/${name}`,
    });
  }

  return {
    provider: GITHUB_PROVIDER,
    repo,
    async writeConnection(tx, { orgId, workspaceId, userId, now }) {
      // The connection the install callback would otherwise have written,
      // with the OAuth account linked for the reason
      // `attachWorkspaceGithubInstallation` gives: a `connected` row with no
      // credential degrades on every poll.
      const oauthAccountId = await orgGithubOauthAccountId(tx, orgId);
      const [connection] = await tx
        .insert(schema.sourceConnections)
        .values({
          orgId,
          workspaceId,
          connectorId: GITHUB_PROVIDER,
          displayName: "GitHub",
          authScheme: "oauth2_authorization_code",
          deliveryMethod: "webhook",
          deliveryConfig: { installationId: installation.installationId },
          ...(oauthAccountId ? { oauthAccountId } : {}),
          // Connected: the workspace binds a repository through it from its
          // first instant, which is the state `bind_main_repository` promotes
          // a connection to.
          status: "connected",
          createdAt: now,
          updatedAt: now,
          createdById: userId,
        })
        .returning({
          id: schema.sourceConnections.id,
          publicId: schema.sourceConnections.publicId,
        });
      if (!connection)
        throw new Error("source_connections insert returned no row");
      return connection;
    },
  };
}

export function createWorkspaceCreateHandler(
  deps: WorkspaceCreateDeps,
): CapabilityHandler<typeof workspaceCreate> {
  return async (input, ctx): Promise<WorkspaceCreateOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    const userId = actingUserId as string;

    const tenant = await withTenantDb((tx) =>
      tx.query.organizations.findFirst({
        where: eq(schema.organizations.id, ctx.orgId),
        columns: { slug: true },
      }),
    );
    if (!tenant) {
      logger.warn({ orgId: ctx.orgId }, "workspace.create: tenant not found");
      throw new HandlerError({ code: "not_found", reason: "org_not_found" });
    }

    // (org_id, slug) uniqueness pre-checked for a typed refusal. The composite
    // unique index still enforces it as a hard constraint.
    const existing = await withTenantDb((tx) =>
      tx.query.workspaces.findFirst({
        where: and(
          eq(schema.workspaces.orgId, ctx.orgId),
          eq(schema.workspaces.slug, input.slug),
        ),
        columns: { id: true },
      }),
    );
    if (existing) {
      logger.warn(
        { orgId: ctx.orgId, slug: input.slug },
        "workspace.create: slug already in use (pre-check)",
      );
      throw slugTaken(input.slug);
    }

    const target =
      input.mainRepo.provider === "gitlab"
        ? await gitlabCreationTarget(
            deps.gitlab ?? gitlabAttachDeps,
            input.mainRepo,
            ctx.surface,
          )
        : await githubCreationTarget(deps, ctx, input.mainRepo);
    const { repo, provider } = target;

    // ── Does another workspace already hold this repository? ──────────────
    // Main or linked: a repository another workspace links cannot become
    // this one's main any more than another workspace's main can. For the
    // sentence; the store's index and trigger are the guarantee, and the
    // catch below turns a lost race into the same sentence. No workspace to
    // exclude: this one does not exist yet.
    await assertGlobalClaimIsKnowable(ctx.orgId);
    const held = await headsHeldElsewhere(repo.id, null, provider);
    if (held.length > 0) {
      logger.warn(
        { orgId: ctx.orgId, repository: repo.fullName },
        "workspace.create: refused — another workspace already holds this repository",
      );
      assertNotHeldElsewhere(repo.fullName, held);
    }

    const now = new Date();
    let created: {
      ws: Awaited<ReturnType<typeof bootstrapWorkspace>>;
      connectionPublicId: string;
      bindingPublicId: string;
    };
    try {
      created = await withTenantDb(async (tx) => {
        // Re-points the transaction's workspace GUC at the new workspace, so
        // every insert below passes its `tenant_isolation` WITH CHECK.
        const ws = await bootstrapWorkspace({
          tx,
          orgId: ctx.orgId,
          userId,
          name: input.name,
          slug: input.slug,
        });
        const scope = { orgId: ctx.orgId, workspaceId: ws.id };
        await assertPlaneStillShared(scope);

        const connection = await target.writeConnection(tx, {
          orgId: ctx.orgId,
          workspaceId: ws.id,
          userId,
          now,
        });

        const head = await writeRepositoryHead(tx, {
          scope,
          connectionId: connection.id,
          repo,
          role: "main",
          provider,
          userId,
          now,
        });
        return {
          ws,
          connectionPublicId: connection.publicId,
          bindingPublicId: head.bindingPublicId,
        };
      });
    } catch (err) {
      if (repositoryHeadConflict(err) !== null) {
        logger.warn(
          { orgId: ctx.orgId, repository: repo.fullName },
          "workspace.create: lost the race for a main repository claim",
        );
        rethrowHeadConflict(err, repo.fullName);
      }
      if (isUniqueViolation(err)) {
        logger.warn(
          { orgId: ctx.orgId, slug: input.slug },
          "workspace.create: slug conflict (race)",
        );
        throw slugTaken(input.slug);
      }
      logger.error(
        { err, orgId: ctx.orgId },
        "workspace.create: transaction failed",
      );
      throw err;
    }

    const { ws } = created;
    logger.info(
      {
        workspaceId: ws.id,
        orgId: ctx.orgId,
        slug: ws.slug,
        repository: repo.fullName,
        surface: ctx.surface,
      },
      "workspace.create: workspace created with its main repository",
    );

    // Record security event for workspace creation (privileged mutation).
    emitSecurityEventAsync({
      eventType: "workspace.created",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ws.id,
      outcome: "success",
      capability: null,
      ip: null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: ctx.orgId, workspaceId: ws.id },
        "workspace.create: failed to record security event",
      );
    });

    return {
      publicId: ws.publicId,
      name: ws.name,
      slug: ws.slug,
      orgSlug: tenant.slug,
      createdAt: ws.createdAt.toISOString(),
      mainRepo: {
        bindingId: created.bindingPublicId,
        connectionId: created.connectionPublicId,
        provider,
        fullName: repo.fullName,
        defaultRef: repo.defaultBranch,
      },
    };
  };
}

export const workspaceCreateHandler = createWorkspaceCreateHandler({
  ...githubUserInstallationsDeps,
  ...githubMainRepositoryDeps,
});
