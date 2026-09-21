import { createGitHubClient, type GitHubClient } from "@oxagen/github";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { HandlerError } from "@oxagen/oxagen";
import { resolveGitHubToken } from "./lib/github-token";
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
        repositoryId: binding.providerRepositoryId,
        owner: binding.providerOwner,
        repo: binding.providerName,
        fullName: binding.providerFullName,
        productionBranch: binding.configuredDefaultRef,
      })
      .from(head)
      .innerJoin(binding, eq(binding.id, head.currentBindingId))
      .innerJoin(connection, eq(connection.id, head.connectionId))
      .where(
        and(
          eq(head.orgId, scope.orgId),
          eq(head.workspaceId, scope.workspaceId),
          eq(head.role, "main"),
          eq(binding.orgId, scope.orgId),
          eq(binding.workspaceId, scope.workspaceId),
          eq(connection.orgId, scope.orgId),
          eq(connection.workspaceId, scope.workspaceId),
          eq(head.provider, "github"),
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
    const github = deps.client(await deps.token(scope));
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
    return { ...bound, github };
  };
}
export const resolveSkillRepository = createSkillRepositoryResolver({
  binding: readSkillRepositoryBinding,
  token: resolveGitHubToken,
  client: (token) => createGitHubClient({ token }),
});
