import { randomUUID } from "node:crypto";
import { HandlerError } from "@oxagen/oxagen";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import { parseSkillConfig } from "./skill-resolution";
import type { SkillConfigStore, SkillScope } from "./skill-config.store";
import type { SkillRepository } from "./skill-config.repository";

const PATH = ".oxagen/skills.toml";

/**
 * The newest commit reachable from `ref` that touched the configuration file.
 * A pull request is the latest change to the file when this commit is the same
 * from its merge commit and from the production head. Matching bytes alone
 * cannot show that: a later revert restores the same bytes under a different
 * pull request, and the earlier one must not publish as the authority.
 */
async function lastConfigCommit(
  repository: SkillRepository,
  ref: string,
): Promise<string | null> {
  const [commit] = await repository.github.listPathCommits({
    owner: repository.owner,
    repo: repository.repo,
    path: PATH,
    ref,
    limit: 1,
  });
  return commit?.sha ?? null;
}

export type SkillConfigServiceDeps = {
  repository(scope: SkillScope): Promise<SkillRepository>;
  store: SkillConfigStore;
  now(): Date;
};
export function createSkillConfigService(deps: SkillConfigServiceDeps) {
  return {
    async propose(scope: SkillScope, text: string) {
      parseSkillConfig(text);
      const repository = await deps.repository(scope);
      const { github, owner, repo } = repository;
      const branch = await github.getBranch({
        owner,
        repo,
        branch: repository.productionBranch,
      });
      if (!branch)
        throw new HandlerError({
          code: "not_found",
          reason: "skill_production_branch_missing",
          message: "The approved production branch no longer exists",
        });
      const head = `oxagen/skills-config-${randomUUID()}`;
      await github.createBranch({
        owner,
        repo,
        branch: head,
        fromBranch: repository.productionBranch,
      });
      await github.putFile({
        owner,
        repo,
        path: PATH,
        branch: head,
        content: text,
        message: "Update skill resolution configuration",
      });
      const pr = await github.openPullRequest({
        owner,
        repo,
        title: "Update skill resolution configuration",
        head,
        base: repository.productionBranch,
        labels: OXAGEN_PR_LABELS,
        body: "Updates `.oxagen/skills.toml`. The merged file controls which skills agents may find. This change grants no tools, model tiers or budget.",
      });
      return { number: pr.number, url: pr.htmlUrl };
    },
    async publish(scope: SkillScope, pullRequestNumber?: number) {
      const repository = await deps.repository(scope);
      const { github, owner, repo } = repository;
      let commitSha: string;
      let publishedAt: string;
      if (pullRequestNumber !== undefined) {
        const pr = await github.getPullRequest({
          owner,
          repo,
          number: pullRequestNumber,
        });
        if (
          !pr.merged ||
          !pr.mergeCommitSha ||
          !pr.mergedAt ||
          pr.baseRef !== repository.productionBranch
        ) {
          throw new HandlerError({
            code: "conflict",
            reason: "skill_config_not_merged",
            message:
              "The configuration must be merged into the approved production branch before publication",
          });
        }
        const files = await github.listPullRequestFiles({
          owner,
          repo,
          number: pullRequestNumber,
        });
        if (
          !files.some((file) => file.path === PATH && file.status !== "removed")
        )
          throw new HandlerError({
            code: "conflict",
            reason: "skill_config_pr_unrelated",
            message:
              "This pull request did not change the skill configuration file.",
          });
        commitSha = pr.mergeCommitSha;
        publishedAt = pr.mergedAt;
      } else {
        const branch = await github.getBranch({
          owner,
          repo,
          branch: repository.productionBranch,
        });
        if (!branch)
          throw new HandlerError({
            code: "not_found",
            reason: "skill_production_branch_missing",
            message: "The approved production branch no longer exists",
          });
        commitSha = branch.sha;
        publishedAt = deps.now().toISOString();
      }
      const file = await github.getFileContent({
        owner,
        repo,
        path: PATH,
        ref: commitSha,
      });
      if (pullRequestNumber !== undefined) {
        const current = await github.getBranch({
          owner,
          repo,
          branch: repository.productionBranch,
        });
        if (!current)
          throw new HandlerError({
            code: "not_found",
            reason: "skill_production_branch_missing",
            message: "The approved production branch no longer exists",
          });
        const currentFile =
          current.sha === commitSha
            ? file
            : await github.getFileContent({
                owner,
                repo,
                path: PATH,
                ref: current.sha,
              });
        if (
          currentFile !== file ||
          (current.sha !== commitSha &&
            (await lastConfigCommit(repository, current.sha)) !==
              (await lastConfigCommit(repository, commitSha)))
        )
          throw new HandlerError({
            code: "conflict",
            reason: "skill_config_superseded",
            message:
              "The production configuration has changed since this pull request merged. Publish its current pull request.",
          });
        const confirmed = await github.getBranch({
          owner,
          repo,
          branch: repository.productionBranch,
        });
        if (confirmed?.sha !== current.sha)
          throw new HandlerError({
            code: "conflict",
            reason: "skill_config_superseded",
            message:
              "The production branch changed during publication. Retry against its current configuration.",
          });
      }
      const parsed = parseSkillConfig(file);
      return deps.store.publish(scope, {
        repositoryBindingId: repository.bindingId,
        commitSha,
        pullRequestNumber: pullRequestNumber ?? null,
        publishedAt,
        ...parsed,
      });
    },
  };
}
