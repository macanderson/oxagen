import { createGitHubClient, type GitHubClient } from "@oxagen/github";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { HandlerError } from "@oxagen/oxagen";
import { resolveGitHubToken } from "./lib/github-token";
import {
  GITHUB_STEERING_PROVIDER,
  mintSteeringInstallationToken,
} from "./lib/steering-app";
import {
  repositoryHostUnsupported,
  steeringInstallationIdOf,
  steeringInstallationMissing,
} from "./repository.bound";
import type { SkillScope } from "./skill-config.store";

export type SkillRepository = {
  bindingId: string;
  owner: string;
  repo: string;
  fullName: string;
  productionBranch: string;
  github: GitHubClient;
};

/** ADR-090 requires an approved binding, including for a legacy connected repository. */
export async function readSkillRepositoryBinding(scope: SkillScope) {
  return withTenantDb(async (tx) => {
    const head = schema.repositoryBindingHeads;
    const binding = schema.repositoryBindings;
    const connection = schema.sourceConnections;
    const [row] = await tx
      .select({
        bindingId: binding.id,
        provider: head.provider,
        connectionId: head.connectionId,
        repositoryId: binding.providerRepositoryId,
        owner: binding.providerOwner,
        repo: binding.providerName,
        fullName: binding.providerFullName,
        productionBranch: binding.configuredDefaultRef,
        // The connection's kind picks the credential. A steering repository
        // the provisioner created hangs from a `github_steering` connection,
        // and its delivery config names the Oxagen GitHub App installation.
        connectorId: connection.connectorId,
        deliveryConfig: connection.deliveryConfig,
      })
      .from(head)
      .innerJoin(binding, eq(binding.id, head.currentBindingId))
      .innerJoin(connection, eq(connection.id, head.connectionId))
      .where(
        and(
          eq(head.orgId, scope.orgId),
          eq(head.workspaceId, scope.workspaceId),
          inArray(head.role, schema.STEERING_HEAD_ROLES),
          eq(binding.orgId, scope.orgId),
          eq(binding.workspaceId, scope.workspaceId),
          eq(connection.orgId, scope.orgId),
          eq(connection.workspaceId, scope.workspaceId),
          isNull(connection.deletedAt),
          notInArray(connection.status, ["deleting", "deleted"]),
        ),
      )
      .limit(1);
    return row;
  });
}
export function createSkillRepositoryResolver(deps: {
  binding: typeof readSkillRepositoryBinding;
  token: typeof resolveGitHubToken;
  client(token: string): GitHubClient;
}) {
  return async (scope: SkillScope): Promise<SkillRepository> => {
    const bound = await deps.binding(scope);
    if (!bound)
      throw new HandlerError({
        code: "not_found",
        reason: "skill_repository_unbound",
        message:
          "Bind the workspace's main repository before configuring skills",
      });
    // Skill configuration writes through a GitHub client. A GitLab main
    // project is refused by name rather than reported as unbound (#3762).
    // That covers a provisioned GitLab steering project too: no stored group
    // token can produce a GitHub client.
    if (bound.provider !== "github")
      throw repositoryHostUnsupported(bound.fullName);
    const github = deps.client(await tokenFor(scope, bound, deps.token));
    const current = await github.getRepoInfo({
      owner: bound.owner,
      repo: bound.repo,
    });
    if (current.id !== bound.repositoryId)
      throw new HandlerError({
        code: "conflict",
        reason: "skill_repository_identity_changed",
        message:
          "The repository at the approved name no longer has its approved identity",
      });
    // The connection's delivery config stays here. Only the fields a skill
    // write needs leave the resolver.
    return {
      bindingId: bound.bindingId,
      owner: bound.owner,
      repo: bound.repo,
      fullName: bound.fullName,
      productionBranch: bound.productionBranch,
      github,
    };
  };
}

/**
 * The token that reaches the bound repository. A steering repository the
 * provisioner created answers only to the Oxagen GitHub App, so its
 * installation mints the token. Every other head uses the workspace's own
 * token for its connection.
 */
async function tokenFor(
  scope: SkillScope,
  bound: NonNullable<Awaited<ReturnType<typeof readSkillRepositoryBinding>>>,
  workspaceToken: typeof resolveGitHubToken,
): Promise<string> {
  if (bound.connectorId !== GITHUB_STEERING_PROVIDER)
    return workspaceToken({ ...scope, connectionId: bound.connectionId });
  const installationId = steeringInstallationIdOf(bound.deliveryConfig);
  if (installationId === null)
    throw steeringInstallationMissing(bound.fullName);
  return mintSteeringInstallationToken(installationId);
}

export const resolveSkillRepository = createSkillRepositoryResolver({
  binding: readSkillRepositoryBinding,
  token: resolveGitHubToken,
  client: (token) => createGitHubClient({ token }),
});
