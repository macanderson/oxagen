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
//      already steers by it, before anything is written.
//   6. ONE transaction: the workspace bootstrap, its GitHub connection (the
//      installation attached, `connected`), the version-1 binding and its
//      `role = 'main'` head. Any failure — including losing the race for the
//      claim to `repository_binding_heads_main_repository_uq` — rolls back the
//      workspace with it. A workspace without a main repo is never written.
//
// Steps 3–5 call GitHub, so they run before the transaction and fail closed:
// a refusal there writes nothing.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  workspaceCreate,
  type WorkspaceCreateOutput,
} from "@oxagen/oxagen/contracts/workspace.create";
import {
  schema,
  withSystemDb,
  withTenantDb,
  isUniqueViolation,
} from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { writeRepositoryHead } from "./repository.binding-write";
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
  assertPlaneStillShared,
  githubMainRepositoryDeps,
  isMainRepositoryConflict,
  repositoryClaimedElsewhere,
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
  MainRepositoryDeps;

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

    // ── The installation, from the org's own GitHub authorization ──────────
    const { owner, name } = input.mainRepo;
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

    const repo = await deps.repository(
      installation.installationId,
      owner,
      name,
    );
    if (!repo) {
      throw new HandlerError({
        code: "not_found",
        reason: "repository_not_installed",
        message: `The GitHub App installation on ${owner} cannot see ${owner}/${name}`,
      });
    }

    // ── Is this repository already another workspace's main repository? ────
    // For the sentence; the unique index is the guarantee, and the catch below
    // turns a lost race into the same sentence.
    await assertGlobalClaimIsKnowable(ctx.orgId);
    const claimed = await withSystemDb((tx) =>
      tx
        .select({ id: schema.repositoryBindingHeads.id })
        .from(schema.repositoryBindingHeads)
        .where(
          and(
            eq(schema.repositoryBindingHeads.provider, GITHUB_PROVIDER),
            eq(schema.repositoryBindingHeads.providerRepositoryId, repo.id),
            eq(schema.repositoryBindingHeads.role, "main"),
          ),
        )
        .limit(1),
    );
    if (claimed.length > 0) {
      logger.warn(
        { orgId: ctx.orgId, repository: repo.fullName },
        "workspace.create: refused — repository is already a main repository elsewhere",
      );
      throw repositoryClaimedElsewhere(repo.fullName);
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

        // The connection the install callback would otherwise have written,
        // with the OAuth account linked for the reason
        // `attachWorkspaceGithubInstallation` gives: a `connected` row with no
        // credential degrades on every poll.
        const oauthAccountId = await orgGithubOauthAccountId(tx, ctx.orgId);
        const [connection] = await tx
          .insert(schema.sourceConnections)
          .values({
            orgId: ctx.orgId,
            workspaceId: ws.id,
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

        const head = await writeRepositoryHead(tx, {
          scope,
          connectionId: connection.id,
          repo,
          role: "main",
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
      if (isMainRepositoryConflict(err)) {
        logger.warn(
          { orgId: ctx.orgId, repository: repo.fullName },
          "workspace.create: lost the race for a main repository claim",
        );
        throw repositoryClaimedElsewhere(repo.fullName);
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
