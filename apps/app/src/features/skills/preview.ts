// `preview_skill_search` output to the search preview's view model.
//
// The candidate's `id` on the wire is the skill's slug in the repository
// catalogue (`code-review`). Oxagen neither mints it nor can validate it as a
// public id, so the view model carries it as `skillRef` (INV-11), and this is
// where the two names meet. It sits in the feature rather than beside the
// other mappers because `previewSkillSearch` is a server action, and a feature
// may not reach `data/live` (INV-07).
import type { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import type { z } from "zod";
import type { SkillSearchPreview } from "@/data/contracts/skills";
import type { ContractOutput } from "@/server/kernel";

const withRef = <T extends { id: string }>({ id, ...rest }: T) => ({
  ...rest,
  skillRef: id,
});

export function toSkillSearchPreview(
  out: ContractOutput<typeof skillSearchPreview>,
): z.input<typeof SkillSearchPreview> {
  return {
    version: out.version,
    repositoryCommitSha: out.repositoryCommitSha,
    tokenCost: out.tokenCost,
    results: out.results.map(withRef),
    withheld: out.withheld.map(withRef),
  };
}
