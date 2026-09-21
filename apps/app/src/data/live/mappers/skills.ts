// `list_skills` output to the Skills page's view model (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`, so a field the contract may leave null
// cannot land in a required view field. Every figure is copied as the handler
// counted it; nothing here fills a count the record did not carry.
import type { skillList } from "@oxagen/oxagen/contracts/skill.list";
import type { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import type { z } from "zod";
import type {
  SkillInventory,
  SkillSearchPreview,
} from "@/data/contracts/skills";
import type { ContractOutput } from "@/server/kernel";

export function toSkillInventory(
  out: ContractOutput<typeof skillList>,
): z.input<typeof SkillInventory> {
  return {
    window: { from: out.window.from, to: out.window.to },
    sessions: out.sessions,
    reportedSessions: out.reportedSessions,
    notReportedSessions: out.notReportedSessions,
    skills: out.skills.map((skill) => ({
      name: skill.name,
      sessions: skill.sessions,
      harnesses: skill.harnesses,
      harnessCount: skill.harnessCount,
      lastSeenAt: skill.lastSeenAt,
    })),
    nextCursor: out.nextCursor,
  };
}

/**
 * `preview_skill_search` output to the search preview's view model. The
 * candidate's `id` is the skill's slug in the repository catalogue, which
 * Oxagen neither mints nor can validate, so the view model carries it as
 * `skillRef` (INV-11) and this is where the two names meet.
 */
export function toSkillSearchPreview(
  out: ContractOutput<typeof skillSearchPreview>,
): z.input<typeof SkillSearchPreview> {
  return {
    version: out.version,
    repositoryCommitSha: out.repositoryCommitSha,
    tokenCost: out.tokenCost,
    results: out.results.map(({ id, ...rest }) => ({
      ...rest,
      skillRef: id,
    })),
    withheld: out.withheld.map(({ id, ...rest }) => ({
      ...rest,
      skillRef: id,
    })),
  };
}
