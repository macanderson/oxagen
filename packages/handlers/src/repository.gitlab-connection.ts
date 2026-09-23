// repository.gitlab-connection.ts — a workspace's GitLab project connections
// (#3762). A connection holds one project access token, so it reaches exactly
// one project; `deliveryConfig` records which one by id and by path.
import {
  createGitLabClient,
  GitLabApiError,
  type GitLabClient,
} from "@oxagen/gitlab";
import { schema, withTenantDb } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { gitlabCredentialRejected } from "./context.steering.gitlab";
import {
  GITLAB_PROVIDER,
  gitlabNotConnected,
  resolveGitLabCredential,
} from "./lib/gitlab-credential";

const RETIRED_STATUSES = ["deleting", "deleted"] as const;

/** What `attach_gitlab_project` records in a connection's `deliveryConfig`. */
export interface GitLabDeliveryConfig {
  /** GitLab's numeric project id, as text. The identity. */
  projectId: string;
  /** `group/sub/project` when the project was connected. A label. */
  projectPath: string;
  /** The project hook Oxagen registered, or null when it could not. */
  webhookId: number | null;
}

/** Read a stored `deliveryConfig`, or null when it is not a GitLab one. */
export function gitlabDeliveryConfigOf(
  raw: unknown,
): GitLabDeliveryConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.projectId !== "string" || !/^[1-9]\d{0,19}$/.test(c.projectId))
    return null;
  if (typeof c.projectPath !== "string" || c.projectPath.length === 0)
    return null;
  return {
    projectId: c.projectId,
    projectPath: c.projectPath,
    webhookId:
      typeof c.webhookId === "number" && Number.isSafeInteger(c.webhookId)
        ? c.webhookId
        : null,
  };
}

/** A live GitLab connection in the caller's workspace. */
export interface WorkspaceGitLabConnection {
  id: string;
  publicId: string;
  status: string;
  config: GitLabDeliveryConfig;
}

/**
 * The workspace's live GitLab connection for a project, matched by id when
 * given one, else by the path it was connected under (case-insensitive, as
 * GitLab paths are). Newest first, so a reconnect wins over an older row.
 */
export async function findWorkspaceGitLabConnection(
  scope: { orgId: string; workspaceId: string },
  project: { id?: string; path?: string },
): Promise<WorkspaceGitLabConnection | null> {
  const rows = await withTenantDb((tx) =>
    tx
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
          eq(schema.sourceConnections.connectorId, GITLAB_PROVIDER),
          isNull(schema.sourceConnections.deletedAt),
          notInArray(schema.sourceConnections.status, [...RETIRED_STATUSES]),
        ),
      )
      .orderBy(desc(schema.sourceConnections.createdAt)),
  );
  for (const row of rows) {
    const config = gitlabDeliveryConfigOf(row.deliveryConfig);
    if (!config) continue;
    const matches =
      (project.id !== undefined && config.projectId === project.id) ||
      (project.path !== undefined &&
        config.projectPath.toLowerCase() === project.path.toLowerCase());
    if (matches)
      return {
        id: row.id,
        publicId: row.publicId,
        status: row.status,
        config,
      };
  }
  return null;
}

/** The repository facts a binding records, as GitLab reports them. */
export interface GitLabRepoInfo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

/**
 * Read the connected project through the connection's own token, by id. A
 * token GitLab rejects refuses without naming anything about the token; a
 * project the token cannot see is null.
 */
export async function readGitLabProject(
  scope: { orgId: string; workspaceId: string },
  connection: WorkspaceGitLabConnection,
  client: (token: string) => GitLabClient = (token) =>
    createGitLabClient({ token }),
): Promise<GitLabRepoInfo | null> {
  const { token } = await resolveGitLabCredential({
    ...scope,
    connectionId: connection.id,
  });
  try {
    const project = await client(token).getProject(connection.config.projectId);
    if (!project.defaultBranch) {
      throw new HandlerError({
        code: "conflict",
        reason: "repository_empty",
        message: `GitLab project ${project.pathWithNamespace} has no default branch yet. Push a first commit, then bind it.`,
      });
    }
    return {
      id: project.id,
      owner: project.namespaceFullPath,
      name: project.path,
      fullName: project.pathWithNamespace,
      defaultBranch: project.defaultBranch,
    };
  } catch (err) {
    if (err instanceof GitLabApiError && err.status === 401)
      throw gitlabCredentialRejected(connection.config.projectPath);
    if (err instanceof GitLabApiError && err.status === 404) return null;
    throw err;
  }
}

export { gitlabNotConnected };
