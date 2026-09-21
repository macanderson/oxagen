import { randomUUID } from "node:crypto";
import { HandlerError } from "@oxagen/oxagen";
import { parseSkillConfig } from "./skill-resolution";
import type { SkillConfigStore, SkillScope } from "./skill-config.store";
import type { SkillRepository } from "./skill-config.repository";

const PATH = ".oxagen/skills.toml";
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
