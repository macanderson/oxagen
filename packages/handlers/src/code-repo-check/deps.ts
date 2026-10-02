// code-repo-check/deps.ts: the production deps of the code repository check.
// Every read runs in the workspace's tenant scope, which the caller opens.
//
// - host: the Oxagen GitHub App's installation token on GitHub (ADR-228), or
//   the GitLab connection's stored project access token.
// - publishedRecords: the registry's active records, the source the Markdown
//   import compares against.
// - blockMerge: workspace.toml at the commit of the workspace's published
//   steering version, read the way try_studio_tool reads the published
//   version (`mcp-studio/import/tool.try.ports.ts`).
// - captureMemories: S6's `ingestMemories`.
// - findings: agent.code_repository_findings, where the check stores what it
//   flags (ADR-263).
import { schema, withTenantDb } from "@oxagen/database";
import { createGitHubClient } from "@oxagen/github";
import { createGitLabClient } from "@oxagen/gitlab";
import type { CodeRepoCheckRequest } from "@oxagen/inngest-functions/code-repo-check-runner";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { postgresSteeringStore } from "../context.steering.store";
import { decryptGitLabCredential, GITLAB_PROVIDER } from "../lib/gitlab-credential";
import { mintSteeringInstallationToken } from "../lib/steering-app";
import { logger } from "../logger";
import { ingestMemories } from "../memory/runner";
import { postgresMemoryStore } from "../memory/store";
import { gitlabDeliveryConfigOf } from "../repository.gitlab-connection";
import { readWorkspaceToml } from "../repository.workspace-toml";
import { steeringRepositoryKey } from "../steering-repo/publisher";
import { postgresVersionStore } from "../steering-repo/version-store";
import { toolsSteeringHost } from "../tools.pr.open";
import { githubCodeHost, gitlabCodeHost, type CodeHost } from "./host";
import type { CheckScope, CodeRepoCheckDeps } from "./run";
import { postgresCodeRepoFindingStore } from "./store";

/** The GitLab project and token a connection holds. */
async function gitlabConnection(
  scope: CheckScope,
  connectionId: string,
): Promise<{ projectId: string; token: string }> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        encryptedPayload: schema.authCredentials.encryptedPayload,
      })
      .from(schema.sourceConnections)
      .innerJoin(
        schema.authCredentials,
        eq(schema.authCredentials.connectionId, schema.sourceConnections.id),
      )
      .where(
        and(
          eq(schema.sourceConnections.id, connectionId),
          eq(schema.sourceConnections.orgId, scope.orgId),
          eq(schema.sourceConnections.workspaceId, scope.workspaceId),
          eq(schema.sourceConnections.connectorId, GITLAB_PROVIDER),
          isNull(schema.sourceConnections.deletedAt),
          notInArray(schema.sourceConnections.status, ["deleting", "deleted"]),
        ),
      )
      .limit(1),
  );
  const config = gitlabDeliveryConfigOf(row?.deliveryConfig);
  const credential = row ? await decryptGitLabCredential(row.encryptedPayload) : null;
  if (!config || !credential)
    throw new HandlerError({
      code: "not_found",
      reason: "gitlab_connection_missing",
      message: `GitLab connection ${connectionId} is gone, or holds no token, so Oxagen cannot check its merge request.`,
    });
  return { projectId: config.projectId, token: credential.token };
}

async function hostFor(request: CodeRepoCheckRequest): Promise<CodeHost> {
  if (request.provider === "github") {
    if (request.installationId === null)
      throw new HandlerError({
        code: "conflict",
        reason: "installation_missing",
        message: "A GitHub check needs the Oxagen GitHub App installation that delivered the pull request.",
      });
    const token = await mintSteeringInstallationToken(request.installationId);
    return githubCodeHost(createGitHubClient({ token }), request.fullName);
  }
  if (request.connectionId === null)
    throw new HandlerError({
      code: "conflict",
      reason: "connection_missing",
      message: "A GitLab check needs the connection that delivered the merge request.",
    });
  const connection = await gitlabConnection(
    { orgId: request.orgId, workspaceId: request.workspaceId },
    request.connectionId,
  );
  return gitlabCodeHost(createGitLabClient({ token: connection.token }), connection.projectId);
}

/**
 * True when the published workspace.toml sets `[code_checks] block_merge =
 * true`. A workspace with no steering repo or no published version, and a
 * file that is missing or does not read as workspace/v1, warns. A host error
 * throws, so the job retries rather than post the wrong conclusion.
 */
async function readBlockMerge(scope: CheckScope): Promise<boolean> {
  const host = toolsSteeringHost();
  const repo = await host.resolveRepository(scope).catch((err: unknown) => {
    if (isHandlerError(err) && err.reason === "workspace_repository_missing") return null;
    throw err;
  });
  if (repo === null) return false;
  const bundle = await postgresVersionStore(scope).current(steeringRepositoryKey(repo));
  if (bundle === null) return false;
  const file = readWorkspaceToml(await host.readFile(repo, WORKSPACE_TOML_PATH, bundle.commit));
  if (file.kind === "unreadable")
    logger.warn(
      { workspaceId: scope.workspaceId, version: bundle.version, issues: file.issues },
      "code-repo-check: the published workspace.toml does not read as workspace/v1, so the check only warns",
    );
  return file.kind === "read" && file.value.code_checks?.block_merge === true;
}

export const codeRepoCheckDeps: CodeRepoCheckDeps = {
  host: hostFor,
  async workspaceSlug(scope) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ slug: schema.workspaces.slug })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, scope.workspaceId),
            eq(schema.workspaces.orgId, scope.orgId),
          ),
        )
        .limit(1),
    );
    if (!row)
      throw new HandlerError({
        code: "not_found",
        reason: "workspace_not_found",
        message: `Workspace ${scope.workspaceId} is not in this organization.`,
      });
    return row.slug;
  },
  async publishedRecords(scope) {
    const rows = await postgresSteeringStore.listActiveRecords(scope);
    return rows.flatMap((row) =>
      row.statement
        ? [
            {
              lineage: row.slug,
              label: row.label ?? null,
              kind: row.kind ?? "",
              effect: row.constraintEffect ?? null,
              statement: row.statement,
              path: row.path ?? null,
            },
          ]
        : [],
    );
  },
  blockMerge: readBlockMerge,
  captureMemories: (scope, memories) =>
    ingestMemories(postgresMemoryStore, scope, memories),
  findings: postgresCodeRepoFindingStore,
  now: () => new Date(),
};
