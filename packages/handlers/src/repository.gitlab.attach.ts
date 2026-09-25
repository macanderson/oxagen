// audit-exempt: the kernel's capability.invoke_* audit records every connect; the security_events taxonomy has no repository-credential type yet, and the token itself is never logged or returned.
//
// repository.gitlab.attach.ts: `attach_gitlab_project` (#3762).
//
// Flow:
//   1. Role gate: org Owner or Admin (INV-29).
//   2. Validate the path, then ask GitLab about the token itself: live, the
//      `api` scope, no administrative scope, and a project bot user.
//   3. Read the project by path through the token. The bot user's name must
//      carry this project's id: that is what makes the token a project access
//      token for THIS project rather than a personal or group token.
//   4. Encrypt the token and a webhook secret into one envelope, then insert
//      the connection and its credential in one transaction, or rotate the
//      credential on the workspace's existing connection for the project.
//   5. Register a project webhook for merge request events, when none is
//      registered yet. A refusal (the token's role is below Maintainer) is
//      reported, not raised: steering works without the webhook.
import { randomBytes } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryGitlabAttach,
  type RepositoryGitlabAttachOutput,
} from "@oxagen/oxagen/contracts/repository.gitlab.attach";
import { createIngestionCryptoAdapter, encrypt } from "@oxagen/crypto";
import { schema, withTenantDb } from "@oxagen/database";
import {
  createGitLabClient,
  GitLabApiError,
  parseGitLabProjectPath,
  type GitLabClient,
  type GitLabProject,
} from "@oxagen/gitlab";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { eq } from "drizzle-orm";
import {
  GITLAB_AUTH_SCHEME,
  GITLAB_PROVIDER,
  resolveGitLabCredential,
  type GitLabCredential,
} from "./lib/gitlab-credential";
import { logger } from "./logger";
import {
  findWorkspaceGitLabConnection,
  type GitLabDeliveryConfig,
} from "./repository.gitlab-connection";

/** The scope a token needs: merge requests and commit statuses are `api`. */
const REQUIRED_SCOPE = "api";

/**
 * Scopes that reach beyond one project's repository. A token carrying any of
 * them is refused even when it is a project token, so a leak of the stored
 * credential can do no more than the connect needs.
 */
const REFUSED_SCOPES = new Set([
  "sudo",
  "admin_mode",
  "create_runner",
  "manage_runner",
]);

export interface GitLabAttachDeps {
  client: (token: string) => GitLabClient;
  /** Envelope-encrypt the credential JSON. */
  seal: (plaintext: string) => Promise<{ keyId: string; ciphertext: string }>;
  /** A fresh webhook secret. */
  newSecret: () => string;
  /** Where GitLab delivers webhooks for a connection. */
  webhookUrl: (connectionPublicId: string) => string;
}

export const gitlabAttachDeps: GitLabAttachDeps = {
  client: (token) => createGitLabClient({ token }),
  async seal(plaintext) {
    const { adapter, keyId } = createIngestionCryptoAdapter();
    const cipher = await encrypt(plaintext, keyId, { adapter });
    return { keyId, ciphertext: cipher.toString("base64") };
  },
  newSecret: () => randomBytes(32).toString("base64url"),
  webhookUrl: (id) =>
    `${(process.env["OXAGEN_API_URL"] ?? "https://api.oxagen.sh").replace(/\/+$/, "")}/webhooks/gitlab/${id}`,
};

function tokenRefused(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/**
 * Verify the token against GitLab and read the project it is for. Every
 * refusal names the project path and the fix, and nothing about the token.
 */
export async function verifyProjectToken(
  gl: GitLabClient,
  projectPath: string,
): Promise<{ project: GitLabProject; expiresAt: string | null }> {
  let token;
  let user;
  try {
    [token, user] = await Promise.all([
      gl.getCurrentToken(),
      gl.getCurrentUser(),
    ]);
  } catch (err) {
    if (
      err instanceof GitLabApiError &&
      (err.status === 401 || err.status === 403)
    )
      throw tokenRefused(
        "gitlab_token_invalid",
        "GitLab did not accept this token. Create a project access token on the project and paste it again.",
      );
    throw err;
  }
  if (!token.active || token.revoked)
    throw tokenRefused(
      "gitlab_token_invalid",
      "GitLab reports this token as revoked or expired. Create a new project access token.",
    );
  if (!token.scopes.includes(REQUIRED_SCOPE))
    throw tokenRefused(
      "gitlab_token_scope",
      "The token needs the api scope, which opening merge requests and reporting commit statuses require.",
    );
  const extra = token.scopes.filter((s) => REFUSED_SCOPES.has(s));
  if (extra.length > 0)
    throw tokenRefused(
      "gitlab_token_scope",
      `The token carries ${extra.join(", ")}, which reaches beyond one project. Create a project access token with the api scope only.`,
    );

  let project: GitLabProject;
  try {
    project = await gl.getProject(projectPath);
  } catch (err) {
    if (
      err instanceof GitLabApiError &&
      (err.status === 404 || err.status === 403)
    )
      throw new HandlerError({
        code: "not_found",
        reason: "repository_not_found",
        message: `This token cannot see ${projectPath} on gitlab.com. Check the path, or create the token on that project.`,
      });
    throw err;
  }
  // GitLab names a project access token's bot user `project_<id>_bot_<hash>`
  // (older tokens: `project_<id>_bot<n>`). A group token's bot is
  // `group_<id>_bot…`, and a personal token belongs to a person.
  if (!user.bot || !user.username.startsWith(`project_${project.id}_bot`))
    throw tokenRefused(
      "gitlab_token_not_project_scoped",
      `Use a project access token created on ${project.pathWithNamespace}. A personal or group token, or another project's token, reaches more than this project.`,
    );
  if (project.archived)
    throw new HandlerError({
      code: "conflict",
      reason: "repository_archived",
      message: `${project.pathWithNamespace} is archived and read-only on GitLab.`,
    });
  if (!project.defaultBranch)
    throw new HandlerError({
      code: "conflict",
      reason: "repository_empty",
      message: `${project.pathWithNamespace} has no default branch yet. Push a first commit, then connect it.`,
    });
  return { project, expiresAt: token.expiresAt };
}

export function createGitLabAttachHandler(
  deps: GitLabAttachDeps,
): CapabilityHandler<typeof repositoryGitlabAttach> {
  return async (input, ctx): Promise<RepositoryGitlabAttachOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    const userId = actingUserId as string;
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const path = parseGitLabProjectPath(input.projectPath);
    if (!path)
      throw new HandlerError({
        code: "conflict",
        reason: "invalid_project_path",
        message: `${input.projectPath} is not a gitlab.com project path. Use group/project, or group/subgroup/project.`,
      });

    const gl = deps.client(input.token);
    const { project, expiresAt } = await verifyProjectToken(gl, path.fullPath);

    const existing = await findWorkspaceGitLabConnection(scope, {
      id: project.id,
    });
    // A rotation keeps the webhook and its secret: the hook GitLab holds is
    // signed with that secret, and replacing it would break deliveries until
    // the hook was re-registered. When the stored secret is gone, the rotation
    // takes a new one and re-registers the hook below, rather than keeping a
    // hook that would refuse every delivery.
    const kept = existing
      ? await storedWebhookSecret(scope, existing.id)
      : null;
    const credential: GitLabCredential = {
      token: input.token,
      webhookSecret: kept ?? deps.newSecret(),
    };
    const staleHookId =
      existing !== null && kept === null ? existing.config.webhookId : null;
    const sealed = await deps.seal(JSON.stringify(credential));
    const now = new Date();
    const config: GitLabDeliveryConfig = {
      projectId: project.id,
      projectPath: project.pathWithNamespace,
      webhookId: kept === null ? null : (existing?.config.webhookId ?? null),
    };

    const connection = await withTenantDb(async (tx) => {
      if (existing) {
        await tx
          .update(schema.authCredentials)
          .set({ encryptedPayload: sealed, updatedAt: now })
          .where(eq(schema.authCredentials.connectionId, existing.id));
        await tx
          .update(schema.sourceConnections)
          .set({
            deliveryConfig: config,
            status: "connected",
            errorMessage: null,
            updatedAt: now,
            updatedById: userId,
          })
          .where(eq(schema.sourceConnections.id, existing.id));
        return { id: existing.id, publicId: existing.publicId };
      }
      const [row] = await tx
        .insert(schema.sourceConnections)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          connectorId: GITLAB_PROVIDER,
          displayName: `GitLab · ${project.pathWithNamespace}`,
          authScheme: GITLAB_AUTH_SCHEME,
          deliveryMethod: "webhook",
          deliveryConfig: config,
          status: "connected",
          createdById: userId,
        })
        .returning({
          id: schema.sourceConnections.id,
          publicId: schema.sourceConnections.publicId,
        });
      if (!row) throw new Error("source_connections insert returned no row");
      await tx.insert(schema.authCredentials).values({
        connectionId: row.id,
        authScheme: GITLAB_AUTH_SCHEME,
        encryptedPayload: sealed,
      });
      return row;
    });

    let webhook: RepositoryGitlabAttachOutput["webhook"];
    if (config.webhookId !== null) {
      webhook = { status: "unchanged" };
    } else {
      if (staleHookId !== null) {
        // The hook signed with the lost secret. Removing it is best effort:
        // one already gone, or a role that cannot manage hooks, leaves nothing
        // this call can do, and the new hook below is what delivers.
        await gl
          .deleteProjectHook({ project: project.id, hookId: staleHookId })
          .catch((err: unknown) => {
            if (
              !(
                err instanceof GitLabApiError &&
                (err.status === 404 || err.status === 403)
              )
            )
              throw err;
          });
      }
      try {
        const hook = await gl.createProjectHook({
          project: project.id,
          url: deps.webhookUrl(connection.publicId),
          token: credential.webhookSecret,
          mergeRequestsEvents: true,
          // A push to the production branch changes the records in force.
          // The repository sync (ADR-182) reads it.
          pushEvents: true,
        });
        await withTenantDb((tx) =>
          tx
            .update(schema.sourceConnections)
            .set({ deliveryConfig: { ...config, webhookId: hook.id } })
            .where(eq(schema.sourceConnections.id, connection.id)),
        );
        webhook = { status: "registered" };
      } catch (err) {
        if (!(err instanceof GitLabApiError && err.status === 403)) throw err;
        webhook = { status: "refused" };
      }
    }

    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        connectionId: connection.publicId,
        projectId: project.id,
        rotated: existing !== null,
        webhook: webhook.status,
      },
      "repository.gitlab.attach: GitLab project connected",
    );

    return {
      connectionId: connection.publicId,
      projectId: project.id,
      fullName: project.pathWithNamespace,
      defaultRef: project.defaultBranch as string,
      tokenExpiresAt: expiresAt,
      rotated: existing !== null,
      webhook,
    };
  };
}

/**
 * The webhook secret already stored on a connection, so a token rotation does
 * not orphan the hook GitLab signs with it. Null when the connection holds no
 * readable credential (`gitlab_not_connected`), which sends the rotation down
 * the re-registration path. Any other failure, such as the key service being
 * unreachable, is thrown: rotating on a guess would leave the hook and the
 * stored secret disagreeing.
 */
async function storedWebhookSecret(
  scope: { orgId: string; workspaceId: string },
  connectionId: string,
): Promise<string | null> {
  try {
    return (await resolveGitLabCredential({ ...scope, connectionId }))
      .webhookSecret;
  } catch (err) {
    if (err instanceof HandlerError && err.reason === "gitlab_not_connected")
      return null;
    throw err;
  }
}

export const repositoryGitlabAttachHandler =
  createGitLabAttachHandler(gitlabAttachDeps);
