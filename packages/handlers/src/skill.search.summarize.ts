// audit-exempt: configuration inspection; no skill is loaded and the kernel audits access.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { skillSearchSummarize } from "@oxagen/oxagen/contracts/skill.search.summarize";
import { agentSkillResolution } from "./skill-resolution";
import {
  createSkillSearchResolver,
  skillSearchDeps,
  type SkillSearchDeps,
} from "./skill.search.preview";

/**
 * The agent's projection of one resolution: the skills it may load, and the
 * withheld ones as a count per reason. It runs the same role gate, snapshot and
 * resolver as `preview_skill_search` and differs only in what it returns.
 */
export function createSkillSearchSummarizeHandler(
  deps: SkillSearchDeps,
): CapabilityHandler<typeof skillSearchSummarize> {
  const resolve = createSkillSearchResolver(deps);
  return async (input, ctx) => {
    const { version, repositoryCommitSha, resolution } = await resolve(
      input,
      ctx,
    );
    return {
      version,
      repositoryCommitSha,
      ...agentSkillResolution(resolution),
    };
  };
}

export const skillSearchSummarizeHandler =
  createSkillSearchSummarizeHandler(skillSearchDeps);
